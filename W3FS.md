# W3FS — Web3 FileSystem Calldata Format

W3FS is a binary encoding for content stored as Ethereum transaction calldata. It gives the web3 browser enough information to decompress and render the payload without any external metadata.

---

## Why calldata

Contract storage (SSTORE) costs ~20,000 gas per 32-byte slot. Calldata costs 16 gas per non-zero byte. For a 1 KB HTML page the difference is roughly **50× cheaper** via calldata.

The trade-off: calldata is write-once and not directly readable by contracts. A URL must reference the chunk's `blockNumber:txIndex` coordinates — directly, or through a name record that stores them.

---

## Binary layout

```
Offset  Size    Field
──────────────────────────────────────────────────────
0       4       Magic: 0x57334653 ("W3FS")
4       1       Version: 0x01
5       2       Content-Type length N (big-endian uint16)
7       N       Content-Type string (UTF-8, e.g. "text/html; charset=utf-8")
7+N     1       Compression:  0 = none
                              1 = gzip
                              2 = deflate
                              3 = brotli
8+N     4       Chunk index (big-endian uint32, 0-based)
12+N    4       Total chunks (big-endian uint32)
16+N    *       Payload bytes
```

---

## Single-chunk example

A gzip-compressed HTML page in one transaction:

```
57 33 46 53          magic
01                   version 1
00 18                content-type length = 24
74 65 78 74 2f 68    "text/html; charset=utf-8"
74 6d 6c 3b 20 63
68 61 72 73 65 74
3d 75 74 66 2d 38
01                   compression = gzip
00 00 00 00          chunk index 0
00 00 00 01          total chunks 1
1f 8b 08 00 ...      gzipped payload
```

---

## Multi-chunk content

Large files (images, JS bundles) that exceed a practical calldata size can be split across multiple transactions. Each transaction carries one chunk with the same total-chunks value, in ascending `chunk index`. The chunks are assembled in index order before decompression.

A name record holds the ordered list of chunk **coordinates** — `[blockNumber, txIndex]` pairs, not transaction hashes. Coordinates let the extension locate each chunk inside a Helios-verified block and prove it against that block's transactions root (a bare tx hash carries no such position). The `w3` text record is a JSON array:

```json
[[19000000, 12], [19000000, 13], [19000042, 4]]
```

```
[19000000, 12]  → chunk 0 of 3
[19000000, 13]  → chunk 1 of 3
[19000042,  4]  → chunk 2 of 3
```

The extension fetches and verifies each transaction independently, then concatenates the payloads and decompresses once.

---

### Direct calldata reference

```
w3://[<chainId>:]<blockNumber>:<txIndex>[+<blockNumber>:<txIndex>...][/path]
```

Points straight at one or more calldata chunks by their `blockNumber:txIndex` coordinates — no name lookup. Multiple chunks are joined with `+` in ascending chunk order. The chain id, when present, is a **leading** `<chainId>:` prefix (verum-specific; a direct reference is not an ERC-4804 host).

```
w3://19000000:12                      single chunk, mainnet
w3://19000000:12+19000000:13          two-chunk file
w3://11155111:8402190:5               single chunk on Sepolia
```

## Multi-file bundles

A whole site is deployed as one bundle (content-type `application/x-w3fs-bundle`). After the outer chunks are concatenated and decompressed, the payload is a binary file table:

```
[4]  file count (uint32 BE)
per file:
  [2]  path length (uint16 BE)
  [N]  path (UTF-8, always starts with "/", bundle-root-relative)
  [2]  mime length (uint16 BE)
  [M]  mime type (UTF-8)
  [4]  data length (uint32 BE)
  [D]  raw file bytes
```

Each stored path **is** the URL path it's served at (`/index.html`, `/assets/app.js`). A request for `/` — i.e. `w3://<name>` with no path — resolves to `/index.html`. Keep an `index.html` at the bundle root, and reference sub-resources by root-relative or relative URLs, never by a local filesystem path. When a bundle has no `/index.html`, the extension renders a directory listing so non-site bundles stay navigable.

---

## Verification

The extension renders content optimistically and verifies it in a second phase, surfacing the result as a live badge (`Verifying…` → `Verified`). Content is shown immediately for responsiveness; interactive content (with scripts) and raw file views stay behind a gate overlay until verification confirms them, and a failed proof raises a warning banner — so nothing is trusted until the proof lands, even though it's displayed first.

The verification itself, for calldata within Helios's recent window:

1. **Helios** syncs to the Ethereum consensus layer via sync-committee signatures and returns a verified block header containing `transactionsRoot`.
2. **Local MPT** — all transactions in the block are fetched, the Patricia Merkle Trie is reconstructed locally, and its root is compared against the Helios-verified `transactionsRoot`.
3. If the roots match, the calldata in the target transaction is cryptographically proven to be part of that block. No trusted RPC can forge it.

Blocks older than Helios's window are proven through a beacon-chain path (EIP-4788 anchor → `BeaconState` historical summaries → era block roots → tx trie). When a name resolves the content, its record is re-resolved through Helios and compared, so the name→coordinates mapping is proven too. See [VERIFICATION.md](VERIFICATION.md) for the full trust chain across all paths.

---

## Tooling

| Script | Purpose |
|--------|---------|
| `scripts/encode-w3fs.js` | Encode a file (or `--dir` a whole site) into W3FS calldata hex — one line per chunk |
| `scripts/publish.js`     | Send each calldata line as a transaction and print the chunk coordinates `[[block, txIndex], …]` |
| `scripts/set-name.js`    | Write those coordinates to a name's `w3` record (ENS `.eth`, GNS `.gwei`, WNS `.wei`) |

```bash
export PRIVATE_KEY=0x…

# 1. Encode + publish. publish.js prints the coordinates and pipes them onward.
node scripts/encode-w3fs.js ./index.html | node scripts/publish.js
#   → browse now at  w3://<block>:<txIndex>

# 2. (optional) point a name at those coordinates so it's browsable by name.
node scripts/encode-w3fs.js ./index.html \
  | node scripts/publish.js \
  | node scripts/set-name.js myapp.eth <rpc-url> "$PRIVATE_KEY"
#   → browse at  w3://myapp.eth
```

`set-name.js` accepts the coordinates on stdin (as above) or as trailing `block:txIndex` arguments. See the script header for the `--resolver` override and per-TLD ownership prerequisites.