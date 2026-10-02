# Verification flow — spec step → code location

How Verum verifies that dapp calldata is part of the canonical Ethereum chain, for
each of the four verification modes. Each mode reaches "trustless" (or its own trust boundary) via a different chain of
custody.

| Mode | Trust boundary | Badge condition |
|---|---|---|
| 1 — Helios (recent) | Trustless (sync committee) | `heliosBacked && trieVerified && ensOk` |
| 2 — Beacon (historical) | Trustless (sync committee via EIP-4788 anchor) | `beaconVerified && beaconHeliosBacked && trieVerified && ensOk` |
| 3 — Portal | Your local Portal node | `portalVerified && ensOk` |
| 4 — Local | Your local execution RPC | `localMode` |

The badge logic at `src/background.ts:923-940` (`updateBadge`) gates green on the *complete* condition for the active
mode; there is no partial-pass green. Anything short — Helios unanchored, trie
mismatch, ENS unverified — shows ✗.

Name-based URLs (`w3://myapp.eth`, `w3://myapp.gwei`) require `ensOk` thourgh helios `ensVerified === true` in modes 1–3.

## Common to all modes (phase 1 — content fetch & assembly)

| Step | Check | Location |
|---|---|---|
| Name → `[[block, txIndex]]` | ENS: `registry.resolver(node)` + `text(node,"w3")`; GNS (.gwei): `text()` directly on NameNFT — via plain RPC at the `latest` tag. Not yet trusted; re-verified per mode below | `src/lib/w3/name-resolver.ts` — `resolveEns:113`, `getResolver:67`, `getText:76`, `ethCall`(latest)`:62` |
| Calldata parsing | W3FS magic, version, chunk index/count, decompression — structural validation, not proof (the content *is* the tx data) | `src/lib/w3/content.ts:58` (`parseCalldata`), `:141` (`assembleContent`) |
| Calldata ∈ tx ∈ trie | `serializeTx` re-encodes every tx (incl. `tx.input` = the calldata) as trie leaves; recomputed root must equal `block.transactionsRoot`, else throw. Rendered bytes come from the same tx object | `src/lib/verify/tx-verifier.ts:257-258` (leaves + trie root in `getVerifiedCalldataByLocation`), `:271` (rendered bytes = `tx.input`) |

Phase 1 renders immediately; the badge stays "···" until one of the four phase-2 modes finishes verification.

## Mode 1 — Recent block, Helios-verified

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction, fetched fresh via Helios
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == transactionsRoot, keccak(header) == blockhash
execution block, served by Helios
  ▼  Helios only serves blocks it already verified against its sync-committee chain
trustless anchor (Helios sync committee)
  ▼  byte-compare Helios-verified calldata against what phase 1 actually rendered
trustless anchor
```

Badge green requires `heliosBacked && trieVerified && ensOk` (`src/background.ts:928` — `heliosVerified`).

| Step | Check | Location |
|---|---|---|
| Header → canonical chain | Helios serves `eth_getBlockByNumber` only after verifying it against its sync-committee-verified chain (EIP-2935 window, ~last 27h); Helios's own consensus verification is the anchor — **run per chunk, all chunks** | `src/background.ts` (Helios phase-2 loop over `phase1Results`), `src/lib/verify/tx-verifier.ts` (`headerVerified: rpc.isHeliosBacked()`) |
| Trie rebuild (again, via Helios data) | Same full-trie reconstruction as phase 1, but over the Helios-served block — per chunk | `src/lib/verify/tx-verifier.ts` (`getVerifiedCalldataByLocation`) |
| **Render binding** | Byte-for-byte comparison of each chunk's Helios-verified calldata against the bytes phase 1 actually rendered — a fast RPC serving a self-consistent forgery in phase 1 fails here (✗) instead of being green-lit by verifying canon at the same coordinates | `src/background.ts` (`bytesEqual` check in the Helios phase-2 loop) |
| ENS/GNS re-verification | Name re-resolved through a Helios-verified `eth_call` at Helios's verified head (`latest`); chunk lists must match phase 1 | `src/lib/w3/name-resolver.ts:104` (`compareEnsChunks`), called from `src/background.ts` |

## Mode 2 — Historical block, beacon-verified

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == transactionsRoot, keccak(header) == blockhash
execution block hash
  ▼  SSZ: hash_tree_root(BeaconBlockBody) == body_root, body.execution_payload.block_hash == blockhash
beacon block root
  ▼  merkleize(block_roots[0..8192]) == historical_summaries[era].block_summary_root
block_summary_root
  ▼  hash_tree_root(BeaconState) == finalized state root
finalized state root
  ▼  Helios EIP-4788 eth_call proves the finalized beacon root trustlessly
trustless anchor
```

Badge green requires `beaconVerified && beaconHeliosAnchored && trieVerified && ensOk`
(`src/background.ts:929` — `beaconTrusted`, in `updateBadge`). 

| Step | Check | Location (file:line) |
|---|---|---|
| tx trie → header → blockhash | Per chunk on the **same block object whose calldata was rendered**: `keccak256(RLP(header)) == blockHash`; `computeTrieRoot(txs) == transactionsRoot`; `tx[txIndex]`. Binds the rendered bytes to the chain | `tx-verifier.ts:342-344` (header keccak), `:347-350` (trie root), `serializeTx:189-215` (RLP leaf); run per chunk from `background.ts` |
| Beacon header authenticity | Local `beaconHeaderRoot(msg)` == the node's claimed root, on **every** header fetched (target, anchor, effectiveSlot) | `beacon-verifier.ts:120` `fetchVerifiedBeaconHeader`; reject at `:131-133` |
| blockhash → beacon body | `hash_tree_root(BeaconBlockBody) == header.body_root`, then extracted `execution_payload.block_hash == tx's blockhash` | body-root: `beacon-verifier.ts:149` `fetchVerifyBeaconBodyHash` → `ssz-state-verifier.ts:1240` `computeBlindedBeaconBlockBodyRoot` (SSZ fallback `:1047`), reject at `beacon-verifier.ts:182`/`:209`; blockhash match: per-target loop `:742` |
| beacon root ∈ era `block_roots` | Per target: `root == eraRoots[slot % 8192]`; the 8192 roots are accepted only if `merkleize(roots) == block_summary_root` (rolling-window / era file / parquet / exec headers / cached Merkle proof) | root∈roots: `beacon-verifier.ts:706-708` (window `:702-703`, cached-proof `:715-717`); merkleize check: `era-file.ts:280-282` via `computeEraBlockSummaryRoot` `beacon-primitives.ts:44` |
| `block_summary_root` ∈ BeaconState | **Full path:** `hash_tree_root(BeaconState) == state root`, BSR extracted from that hashed state. **Fast path (era-tail):** reconstruct the state root from the HS blob + LC-branch siblings + fixed section, require `== header.state_root`, plus an independent field proof | full: `beacon-state.ts:75` `computeBeaconStateRoot` (`ssz:801`), `:99` extract BSR, `:104`; fast path: `beacon-verifier.ts:290` `tryEraTailStateSummary`, bind `:381`; `ssz-state-verifier.ts:984` `reconstructStateRootFromHistSummaries`, `:938` `verifyHistoricalSummariesFieldProof` |
| state root → beacon block root | `header.state_root == effectiveStateRoot` ties the verified state to a beacon header whose `hash_tree_root == effectiveBeaconRoot` | `beacon-verifier.ts:589-591` (full) / `:381`,`:386` (era-tail) |
| beacon root → trustless anchor | EIP-4788 ring read via a **Helios-verified** `eth_call` at `finalized` == `effectiveBeaconRoot`, once per batch; gated on `isHeliosBacked()` | `beacon-verifier.ts:241` `confirmWithHelios`: gate `:247`, eth_call `:254-256`, reject `:262` |
| ENS/GNS re-verification | Same Helios re-resolution as Mode 1; `compareEnsChunks` must match the phase-1 list | `src/lib/w3/name-resolver.ts:104` `compareEnsChunks`, called from `src/background.ts` |

## Mode 3 — Portal-trusted

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata ∈ tx ∈ block ∈ canonical chain — verified by the Portal node before storing
trusted anchor: your own Portal node
```

Badge green requires `portalVerified && ensOk` (`src/background.ts:927` — `portalTrusted`).

| Step | Check | Location |
|---|---|---|
| calldata ∈ tx ∈ block ∈ canonical chain | **Delegated to the user's local Portal node** — it verified the body against the header chain before storing. No local re-verification, by design; the beacon pipeline is skipped entirely | `src/background.ts:515` (Portal branch + early return), fetch `src/lib/rpc/portal.ts:80` (`getCalldataViaPortal`) |
| ENS/GNS re-verification | Still done through Helios (started in parallel), even in Portal mode | `src/lib/w3/name-resolver.ts:104` (`compareEnsChunks`), called from `src/background.ts` |

Trust boundary: local portal node. The only cryptographic check the extension itself performs in this mode is the ENS/GNS cross-check.

## Mode 4 — Local mode

```
dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction, from the local RPC
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == RPC's own claimed transactionsRoot
trusted anchor: your own execution RPC (no blockhash/canonicality check beyond this)
```

Badge green unconditionally: `localMode === true` (`src/background.ts:930` — part of `fullyVerified`).

| Step | Check | Location |
|---|---|---|
| Trie rebuild | Phase 1's full trie reconstruction still runs (throws on mismatch) — but against the *local RPC's own claimed* `transactionsRoot`; header→blockhash and canonicality are not checked | `src/lib/verify/tx-verifier.ts:257-258` via `src/background.ts:412` (`rpcs[0]` only in local mode) |
| Everything else | **Trusted to the local execution RPC** — no Helios, no beacon, no ENS re-check (`ensVerified` not required) | `src/background.ts:572-578` (local-mode branch → `localMode: true`) |

Trust boundary: whatever node `rpcs[0]` points at — the mode exists for users running
their own full node, where verification against yourself is meaningless.