/**
 * Full BeaconState SSZ hash_tree_root computation.
 *
 * Implements every field type needed to locally verify:
 *   hash_tree_root(beacon_state_at_era_end) == state_root
 *
 * where state_root comes from the era-end beacon block header, which is itself
 * SSZ-verified against eraBlockRoots[8191] (proven via SHA-256 Merkle from
 * historical_summaries[era].block_summary_root).
 *
 * This closes the final cryptographic link:
 *   Helios → parentBeaconBlockRoot → state_root → historical_summaries[era]
 */

import { sha256, getBytes, hexlify } from 'ethers'

// ---------------------------------------------------------------------------
// Zero-hash table: ZERO[i] = root of a tree of depth i filled with zeros
// ---------------------------------------------------------------------------

const ZERO: Uint8Array[] = (() => {
  const h: Uint8Array[] = [new Uint8Array(32)]
  for (let i = 1; i <= 64; i++) {
    const p = new Uint8Array(64)
    p.set(h[i - 1], 0)
    p.set(h[i - 1], 32)
    h.push(getBytes(sha256(p)))
  }
  return h
})()

// ---------------------------------------------------------------------------
// Core SSZ primitives
// ---------------------------------------------------------------------------

function h(a: Uint8Array, b: Uint8Array): Uint8Array {
  const p = new Uint8Array(64)
  p.set(a, 0)
  p.set(b, 32)
  return getBytes(sha256(p))
}

/**
 * Merkleize `chunks` in a virtual tree of depth `depth` (2^depth leaves).
 * Missing leaves are implicitly zero — we use ZERO[d] for efficiency.
 */
function merkleizeAtDepth(chunks: Uint8Array[], depth: number): Uint8Array {
  let layer: (Uint8Array | undefined)[] = chunks.slice()
  for (let d = 0; d < depth; d++) {
    const pairs = Math.ceil(layer.length / 2)
    const next: (Uint8Array | undefined)[] = []
    for (let i = 0; i < pairs; i++) {
      next.push(h(layer[2 * i] ?? ZERO[d], layer[2 * i + 1] ?? ZERO[d]))
    }
    layer = next
  }
  return layer[0] ?? ZERO[depth]
}

/** Merkleize exactly a power-of-2 list of chunks (no virtual padding needed). */
function merkleizeExact(chunks: Uint8Array[]): Uint8Array {
  let layer = chunks.slice()
  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) next.push(h(layer[i], layer[i + 1]))
    layer = next
  }
  return layer[0] ?? new Uint8Array(32)
}

/** Returns sibling hashes proving chunks[index] in an exact power-of-2 tree. */
function merkleProofExact(chunks: Uint8Array[], index: number): Uint8Array[] {
  let layer = [...chunks]
  const proof: Uint8Array[] = []
  let idx = index
  while (layer.length > 1) {
    proof.push(layer[idx ^ 1])
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) next.push(h(layer[i], layer[i + 1]))
    layer = next
    idx >>= 1
  }
  return proof
}

/** SSZ mix_in_length: sha256(root ++ LE64(length)) */
function mixLen(root: Uint8Array, length: number): Uint8Array {
  const lc = new Uint8Array(32)
  let l = length
  for (let i = 0; i < 8; i++) { lc[i] = l & 0xff; l = (l / 256) | 0 }
  return h(root, lc)
}

/** Pad bytes to 32 (right-padding with zeros). */
function pad32(b: Uint8Array): Uint8Array {
  if (b.length === 32) return b
  const r = new Uint8Array(32)
  r.set(b.slice(0, 32))
  return r
}

/** LE uint64 as 32-byte chunk. */
function u64chunk(b8: Uint8Array): Uint8Array { return pad32(b8) }

/** Pack bytes into 32-byte chunks (right-padding last chunk with zeros). */
function chunkify(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) return []
  const n = Math.ceil(data.length / 32)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const c = new Uint8Array(32)
    c.set(data.slice(i * 32, Math.min((i + 1) * 32, data.length)))
    chunks.push(c)
  }
  return chunks
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

// ---------------------------------------------------------------------------
// SSZ type hash_tree_root implementations
// ---------------------------------------------------------------------------

// BLSPubkey (48 bytes) → sha256(pubkey[0:32] ++ pubkey[32:48]+zeros[16])
function rootBLSPubkey(b: Uint8Array): Uint8Array {
  return h(b.slice(0, 32), pad32(b.slice(32, 48)))
}

// Fork container {previous_version[4], current_version[4], epoch[8]} → 4 leaves
function rootFork(b: Uint8Array): Uint8Array {
  return merkleizeExact([pad32(b.slice(0, 4)), pad32(b.slice(4, 8)), u64chunk(b.slice(8, 16)), ZERO[0]])
}

// BeaconBlockHeader {slot[8], proposer_index[8], parent_root[32], state_root[32], body_root[32]} → 8 leaves
function rootBeaconBlockHeader(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    u64chunk(b.slice(0, 8)), u64chunk(b.slice(8, 16)),
    b.slice(16, 48), b.slice(48, 80), b.slice(80, 112),
    ZERO[0], ZERO[0], ZERO[0],
  ])
}

// Eth1Data {deposit_root[32], deposit_count[8], block_hash[32]} → 4 leaves
function rootEth1Data(b: Uint8Array): Uint8Array {
  return merkleizeExact([b.slice(0, 32), u64chunk(b.slice(32, 40)), b.slice(40, 72), ZERO[0]])
}

// Checkpoint {epoch[8], root[32]} → 2 leaves
function rootCheckpoint(b: Uint8Array): Uint8Array {
  return h(u64chunk(b.slice(0, 8)), b.slice(8, 40))
}

// SyncCommittee {pubkeys: Vector[BLSPubkey, 512], aggregate_pubkey: BLSPubkey}
// 512*48 = 24576 bytes for pubkeys, then 48 bytes for aggregate = 24624 total
function rootSyncCommittee(b: Uint8Array): Uint8Array {
  // 512 pubkey roots → 2^9 exact
  const pkRoots: Uint8Array[] = []
  for (let i = 0; i < 512; i++) pkRoots.push(rootBLSPubkey(b.slice(i * 48, (i + 1) * 48)))
  const pubkeysRoot = merkleizeExact(pkRoots)
  const aggRoot = rootBLSPubkey(b.slice(24576, 24624))
  return h(pubkeysRoot, aggRoot) // 2-field container
}

// Validator SSZ: pubkey[48]+withdrawal_creds[32]+effective_balance[8]+slashed[1]+4×epoch[8] = 121 bytes
function rootValidator(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    rootBLSPubkey(b.slice(0, 48)),   // pubkey
    b.slice(48, 80),                  // withdrawal_credentials
    u64chunk(b.slice(80, 88)),        // effective_balance
    pad32(b.slice(88, 89)),           // slashed
    u64chunk(b.slice(89, 97)),        // activation_eligibility_epoch
    u64chunk(b.slice(97, 105)),       // activation_epoch
    u64chunk(b.slice(105, 113)),      // exit_epoch
    u64chunk(b.slice(113, 121)),      // withdrawable_epoch
  ])
}

// HistoricalSummary {block_summary_root[32], state_summary_root[32]} → sha256(a++b)
function rootHistoricalSummary(b: Uint8Array): Uint8Array {
  return h(b.slice(0, 32), b.slice(32, 64))
}

// ByteList[maxBytes] — length mixed in, maxChunks = ceil(maxBytes/32)
function rootByteList(data: Uint8Array, maxChunkDepth: number): Uint8Array {
  return mixLen(merkleizeAtDepth(chunkify(data), maxChunkDepth), data.length)
}

// ByteVector[256] = logs_bloom: 8 chunks of 32 bytes → merkleizeExact(8=2^3)
function rootLogsBloom(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    b.slice(0,32), b.slice(32,64), b.slice(64,96), b.slice(96,128),
    b.slice(128,160), b.slice(160,192), b.slice(192,224), b.slice(224,256),
  ])
}

/**
 * ExecutionPayloadHeader — detect fork by the extra_data offset at position 436:
 *   Capella fixed prefix = 568 → extra_data offset = 568 (15 fields → 16 leaves)
 *   Deneb   fixed prefix = 584 → extra_data offset = 584 (17 fields → 32 leaves)
 *   Electra fixed prefix = 680 → extra_data offset = 680 (20 fields → 32 leaves)
 *     adds deposit_requests_root[32], withdrawal_requests_root[32], consolidation_requests_root[32]
 */
function rootExecutionPayloadHeader(b: Uint8Array): Uint8Array {
  const extraDataOffset = readU32LE(b, 436)
  const isDenebPlus  = extraDataOffset >= 584
  const isElectraPlus = extraDataOffset >= 680

  const extraDataRoot = rootByteList(b.slice(extraDataOffset), 0)

  const leaves: Uint8Array[] = [
    b.slice(0, 32),              // parent_hash
    pad32(b.slice(32, 52)),      // fee_recipient (20 bytes)
    b.slice(52, 84),             // state_root
    b.slice(84, 116),            // receipts_root
    rootLogsBloom(b.slice(116, 372)), // logs_bloom
    b.slice(372, 404),           // prev_randao
    u64chunk(b.slice(404, 412)), // block_number
    u64chunk(b.slice(412, 420)), // gas_limit
    u64chunk(b.slice(420, 428)), // gas_used
    u64chunk(b.slice(428, 436)), // timestamp
    extraDataRoot,               // extra_data
    b.slice(440, 472),           // base_fee_per_gas (uint256)
    b.slice(472, 504),           // block_hash
    b.slice(504, 536),           // transactions_root
    b.slice(536, 568),           // withdrawals_root (Capella+)
  ]

  if (!isDenebPlus) {
    leaves.push(ZERO[0])         // 15 fields → 16 leaves
    return merkleizeExact(leaves)
  }

  leaves.push(
    u64chunk(b.slice(568, 576)), // blob_gas_used (Deneb+)
    u64chunk(b.slice(576, 584)), // excess_blob_gas (Deneb+)
  )

  if (isElectraPlus) {
    leaves.push(
      b.slice(584, 616),         // deposit_requests_root (Electra+)
      b.slice(616, 648),         // withdrawal_requests_root (Electra+)
      b.slice(648, 680),         // consolidation_requests_root (Electra+)
    )
  }

  // 17 fields (Deneb) or 20 fields (Electra) → pad to 32 leaves
  while (leaves.length < 32) leaves.push(ZERO[0])
  return merkleizeExact(leaves)
}

// ---------------------------------------------------------------------------
// List/Vector helpers using known SSZ limits (depths)
// ---------------------------------------------------------------------------

// Vector[Root, 8192] = 2^13
function rootVectorRoot8192(data: Uint8Array): Uint8Array {
  const cs: Uint8Array[] = []
  for (let i = 0; i < 8192; i++) cs.push(data.slice(i * 32, (i + 1) * 32))
  return merkleizeExact(cs)
}

// Vector[Bytes32, 65536] = 2^16 (randao_mixes)
function rootVectorBytes32_65536(data: Uint8Array): Uint8Array {
  const cs: Uint8Array[] = []
  for (let i = 0; i < 65536; i++) cs.push(data.slice(i * 32, (i + 1) * 32))
  return merkleizeExact(cs)
}

// Vector[Gwei, 8192] (slashings): pack 4 uint64 per chunk → 2048 = 2^11 chunks
function rootVectorGwei8192(data: Uint8Array): Uint8Array {
  return merkleizeExact(chunkify(data)) // 8192*8=65536 bytes → 2048 chunks, already 2^11
}

// List[Root, 2^24] (historical_roots)
function rootListRoot_2_24(data: Uint8Array): Uint8Array {
  const n = data.length / 32
  if (n === 0) return mixLen(ZERO[24], 0)
  const cs: Uint8Array[] = []
  for (let i = 0; i < n; i++) cs.push(data.slice(i * 32, (i + 1) * 32))
  return mixLen(merkleizeAtDepth(cs, 24), n)
}

// List[Eth1Data, 2048=2^11] (eth1_data_votes), each entry 72 bytes
function rootListEth1Data(data: Uint8Array): Uint8Array {
  const n = data.length / 72
  if (n === 0) return mixLen(ZERO[11], 0)
  const hs: Uint8Array[] = []
  for (let i = 0; i < n; i++) hs.push(rootEth1Data(data.slice(i * 72, (i + 1) * 72)))
  return mixLen(merkleizeAtDepth(hs, 11), n)
}

// List[Validator, 2^40] (validators), each entry 121 bytes
// chunk limit depth = 40 (one hash per validator element)
function rootListValidator(data: Uint8Array): Uint8Array {
  const n = data.length / 121
  if (n === 0) return mixLen(ZERO[40], 0)
  const hs: Uint8Array[] = []
  for (let i = 0; i < n; i++) hs.push(rootValidator(data.slice(i * 121, (i + 1) * 121)))
  return mixLen(merkleizeAtDepth(hs, 40), n)
}

// List[Gwei, 2^40] (balances) — uint64 values packed 4 per chunk → depth 38
function rootListGwei(data: Uint8Array): Uint8Array {
  const n = data.length / 8 // number of uint64 entries
  if (n === 0) return mixLen(ZERO[38], 0)
  return mixLen(merkleizeAtDepth(chunkify(data), 38), n)
}

// List[ParticipationFlags, 2^40] — uint8 values packed 32 per chunk → depth 35
function rootListParticipation(data: Uint8Array): Uint8Array {
  const n = data.length // number of uint8 entries
  if (n === 0) return mixLen(ZERO[35], 0)
  return mixLen(merkleizeAtDepth(chunkify(data), 35), n)
}

// List[uint64, 2^40] (inactivity_scores) — same packing as balances → depth 38
function rootListUint64(data: Uint8Array): Uint8Array {
  const n = data.length / 8
  if (n === 0) return mixLen(ZERO[38], 0)
  return mixLen(merkleizeAtDepth(chunkify(data), 38), n)
}

// ---------------------------------------------------------------------------
// BeaconBlockBody SSZ field helpers
// ---------------------------------------------------------------------------

// BLSSignature (96 bytes): 3 chunks → depth 2
function rootBLSSignature(b: Uint8Array): Uint8Array {
  return h(h(b.slice(0, 32), b.slice(32, 64)), h(b.slice(64, 96), ZERO[0]))
}

// AttestationData (128 bytes): 5 fields → 8 leaves
function rootAttestationData(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    u64chunk(b.slice(0, 8)),          // slot
    u64chunk(b.slice(8, 16)),         // index
    b.slice(16, 48),                  // beacon_block_root
    rootCheckpoint(b.slice(48, 88)),  // source
    rootCheckpoint(b.slice(88, 128)), // target
    ZERO[0], ZERO[0], ZERO[0],
  ])
}

// Bitlist[N]: strip sentinel bit, chunk, mix_in_length
function rootBitlist(data: Uint8Array, chunkDepth: number): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[chunkDepth], 0)
  const lastByte = data[data.length - 1]
  let sentinelBit = 0
  for (let i = 7; i >= 0; i--) { if (lastByte & (1 << i)) { sentinelBit = i; break } }
  const bitCount = (data.length - 1) * 8 + sentinelBit
  const stripped = new Uint8Array(data)
  stripped[stripped.length - 1] = lastByte ^ (1 << sentinelBit)
  return mixLen(merkleizeAtDepth(chunkify(stripped), chunkDepth), bitCount)
}

// IndexedAttestation: attesting_indices offset[4], data[128], signature[96], variable indices
function rootIndexedAttestation(b: Uint8Array): Uint8Array {
  const offIdx = readU32LE(b, 0)
  const indices = b.slice(offIdx)
  const n = indices.length / 8
  // List[ValidatorIndex, 2048]: uint64 packed 4/chunk → max 512 chunks = 2^9
  const indicesRoot = n === 0
    ? mixLen(ZERO[9], 0)
    : mixLen(merkleizeAtDepth(chunkify(indices), 9), n)
  return merkleizeExact([indicesRoot, rootAttestationData(b.slice(4, 132)), rootBLSSignature(b.slice(132, 228)), ZERO[0]])
}

// Attestation: aggregation_bits offset[4], data[128], signature[96], variable bits
function rootAttestation(b: Uint8Array): Uint8Array {
  const offBits = readU32LE(b, 0)
  // Bitlist[2048]: max capacity 8 chunks = 2^3
  return merkleizeExact([
    rootBitlist(b.slice(offBits), 3),
    rootAttestationData(b.slice(4, 132)),
    rootBLSSignature(b.slice(132, 228)),
    ZERO[0],
  ])
}

// SyncAggregate: sync_committee_bits[64] + sync_committee_signature[96]
function rootSyncAggregate(b: Uint8Array): Uint8Array {
  return h(h(b.slice(0, 32), b.slice(32, 64)), rootBLSSignature(b.slice(64, 160)))
}

// SignedBeaconBlockHeader: message[112] + signature[96]
function rootSignedBeaconBlockHeader(b: Uint8Array): Uint8Array {
  return h(rootBeaconBlockHeader(b.slice(0, 112)), rootBLSSignature(b.slice(112, 208)))
}

// DepositData: pubkey[48] + withdrawal_credentials[32] + amount[8] + signature[96]
function rootDepositData(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    rootBLSPubkey(b.slice(0, 48)),
    b.slice(48, 80),
    u64chunk(b.slice(80, 88)),
    rootBLSSignature(b.slice(88, 184)),
  ])
}

// Deposit: proof Vector[Bytes32, 33] (1056 bytes) + data DepositData (184 bytes)
function rootDeposit(b: Uint8Array): Uint8Array {
  const proofLeaves: Uint8Array[] = []
  for (let i = 0; i < 33; i++) proofLeaves.push(b.slice(i * 32, (i + 1) * 32))
  return h(merkleizeAtDepth(proofLeaves, 6), rootDepositData(b.slice(1056, 1240)))
}

// SignedVoluntaryExit: VoluntaryExit[16] + signature[96]
function rootSignedVoluntaryExit(b: Uint8Array): Uint8Array {
  const voluntaryExitRoot = h(u64chunk(b.slice(0, 8)), u64chunk(b.slice(8, 16)))
  return h(voluntaryExitRoot, rootBLSSignature(b.slice(16, 112)))
}

// BLSToExecutionChange: validator_index[8] + from_bls_pubkey[48] + to_address[20]
function rootBLSToExecutionChange(b: Uint8Array): Uint8Array {
  return merkleizeExact([u64chunk(b.slice(0, 8)), rootBLSPubkey(b.slice(8, 56)), pad32(b.slice(56, 76)), ZERO[0]])
}

// SignedBLSToExecutionChange: message[76] + signature[96]
function rootSignedBLSToExecutionChange(b: Uint8Array): Uint8Array {
  return h(rootBLSToExecutionChange(b.slice(0, 76)), rootBLSSignature(b.slice(76, 172)))
}

// Parse a List of variable-length SSZ elements using the offset table
function parseVariableList(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) return []
  const firstOff = readU32LE(data, 0)
  const n = firstOff / 4
  const offs: number[] = []
  for (let i = 0; i < n; i++) offs.push(readU32LE(data, i * 4))
  return offs.map((off, i) => data.slice(off, offs[i + 1] ?? data.length))
}

// ---------------------------------------------------------------------------
// Fork type — detected from BeaconBlockBody fixed prefix size
// ---------------------------------------------------------------------------

type ForkName = 'bellatrix' | 'capella' | 'deneb' | 'electra'

// ---------------------------------------------------------------------------
// Electra-specific types
// ---------------------------------------------------------------------------

// AttestationElectra: aggregation_bits offset[4], data[128], committee_bits[8], signature[96]
// aggregation_bits: Bitlist[131072] → chunk capacity 512 = 2^9 → depth 9
function rootAttestationElectra(b: Uint8Array): Uint8Array {
  const offAggBits = readU32LE(b, 0)
  const la = rootBitlist(b.slice(offAggBits), 9)
  const ld = rootAttestationData(b.slice(4, 132))
  const ls = rootBLSSignature(b.slice(132, 228))
  const lc = pad32(b.slice(228, 236))
  return merkleizeExact([la, ld, ls, lc])
}

// Electra list roots (changed max sizes)
function rootListAttestationsElectra(data: Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[3], 0)  // MAX_ATTESTATIONS_PER_BLOCK_ELECTRA = 8 = 2^3
  const roots = parseVariableList(data).map(rootAttestationElectra)
  return mixLen(merkleizeAtDepth(roots, 3), roots.length)
}

function rootListAttesterSlashingsElectra(data: Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[0], 0)  // MAX_ATTESTER_SLASHINGS_ELECTRA = 1 = 2^0
  const items = parseVariableList(data)
  const roots = items.map(b => {
    const off1 = readU32LE(b, 0)
    const off2 = readU32LE(b, 4)
    // IndexedAttestation is unchanged in Electra (still max 2048 validators, depth 9)
    return h(rootIndexedAttestation(b.slice(off1, off2)), rootIndexedAttestation(b.slice(off2)))
  })
  return mixLen(merkleizeAtDepth(roots, 0), roots.length)
}

// Electra execution request types
// DepositRequest: pubkey[48]+withdrawal_credentials[32]+amount[8]+signature[96]+index[8] = 192 bytes
function rootDepositRequest(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    rootBLSPubkey(b.slice(0, 48)), b.slice(48, 80), u64chunk(b.slice(80, 88)),
    rootBLSSignature(b.slice(88, 184)), u64chunk(b.slice(184, 192)),
    ZERO[0], ZERO[0], ZERO[0],
  ])
}

// WithdrawalRequest: source_address[20]+validator_pubkey[48]+amount[8] = 76 bytes
function rootWithdrawalRequest(b: Uint8Array): Uint8Array {
  return merkleizeExact([pad32(b.slice(0, 20)), rootBLSPubkey(b.slice(20, 68)), u64chunk(b.slice(68, 76)), ZERO[0]])
}

// ConsolidationRequest: source_address[20]+source_pubkey[48]+target_pubkey[48] = 116 bytes
function rootConsolidationRequest(b: Uint8Array): Uint8Array {
  return merkleizeExact([pad32(b.slice(0, 20)), rootBLSPubkey(b.slice(20, 68)), rootBLSPubkey(b.slice(68, 116)), ZERO[0]])
}

function rootListDepositRequests(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 192)
  if (n === 0) return mixLen(ZERO[13], 0)  // MAX_DEPOSIT_REQUESTS_PER_PAYLOAD = 8192 = 2^13
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootDepositRequest(data.slice(i * 192, (i + 1) * 192)))
  return mixLen(merkleizeAtDepth(roots, 13), n)
}

function rootListWithdrawalRequests(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 76)
  if (n === 0) return mixLen(ZERO[4], 0)   // MAX_WITHDRAWAL_REQUESTS_PER_PAYLOAD = 16 = 2^4
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootWithdrawalRequest(data.slice(i * 76, (i + 1) * 76)))
  return mixLen(merkleizeAtDepth(roots, 4), n)
}

function rootListConsolidationRequests(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 116)
  if (n === 0) return mixLen(ZERO[1], 0)   // MAX_CONSOLIDATION_REQUESTS_PER_PAYLOAD = 2 = 2^1 (Fulu)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootConsolidationRequest(data.slice(i * 116, (i + 1) * 116)))
  return mixLen(merkleizeAtDepth(roots, 1), n)
}

// ExecutionRequests container: deposits offset[4], withdrawals offset[4], consolidations offset[4]
function rootExecutionRequests(erSSZ: Uint8Array): Uint8Array {
  if (erSSZ.length === 0) return merkleizeExact([mixLen(ZERO[13], 0), mixLen(ZERO[4], 0), mixLen(ZERO[1], 0), ZERO[0]])
  const offDep  = readU32LE(erSSZ, 0)
  const offWdR  = readU32LE(erSSZ, 4)
  const offCon  = readU32LE(erSSZ, 8)
  return merkleizeExact([
    rootListDepositRequests(erSSZ.slice(offDep, offWdR)),
    rootListWithdrawalRequests(erSSZ.slice(offWdR, offCon)),
    rootListConsolidationRequests(erSSZ.slice(offCon)),
    ZERO[0],
  ])
}

// ---------------------------------------------------------------------------
// ExecutionPayload (full, not header) hash_tree_root
//
// block_hash is always at [472, 504) regardless of fork.
// Variable field layout by fork:
//   Bellatrix (14 fields, fixed prefix 508): extra_data, transactions
//   Capella   (15 fields, fixed prefix 512): extra_data, transactions, withdrawals
//   Deneb     (17 fields, fixed prefix 528): same variable fields; blob_gas_used/excess in fixed prefix
//   Electra   (20 fields, fixed prefix 540): adds deposit_requests, withdrawal_requests, consolidation_requests
// ---------------------------------------------------------------------------

function rootExecutionPayload(ep: Uint8Array, fork: ForkName): Uint8Array {
  const extraDataOffset = readU32LE(ep, 436)  // equals fixed prefix size
  const txOffset = readU32LE(ep, 504)

  // Bellatrix has no withdrawals — transactions is the last variable field
  const wdOffset  = fork !== 'bellatrix' ? readU32LE(ep, 508) : ep.length
  const depReqOff = fork === 'electra'   ? readU32LE(ep, 528) : ep.length
  const wdReqOff  = fork === 'electra'   ? readU32LE(ep, 532) : ep.length
  const conReqOff = fork === 'electra'   ? readU32LE(ep, 536) : ep.length

  const extraData    = ep.slice(extraDataOffset, txOffset)
  const transactions = ep.slice(txOffset, wdOffset)
  const withdrawals  = ep.slice(wdOffset, depReqOff)  // empty for Bellatrix

  const txRoots = parseVariableList(transactions).map(tx => rootByteList(tx, 25))
  const txListRoot = txRoots.length === 0 ? mixLen(ZERO[20], 0) : mixLen(merkleizeAtDepth(txRoots, 20), txRoots.length)

  const nWd = Math.floor(withdrawals.length / 44)
  const wdRoots: Uint8Array[] = []
  for (let i = 0; i < nWd; i++) {
    const w = withdrawals.slice(i * 44, (i + 1) * 44)
    wdRoots.push(merkleizeExact([u64chunk(w.slice(0, 8)), u64chunk(w.slice(8, 16)), pad32(w.slice(16, 36)), u64chunk(w.slice(36, 44))]))
  }
  const wdListRoot = nWd === 0 ? mixLen(ZERO[4], 0) : mixLen(merkleizeAtDepth(wdRoots, 4), nWd)

  const leaves: Uint8Array[] = [
    ep.slice(0, 32),                     // parent_hash
    pad32(ep.slice(32, 52)),             // fee_recipient
    ep.slice(52, 84),                    // state_root
    ep.slice(84, 116),                   // receipts_root
    rootLogsBloom(ep.slice(116, 372)),   // logs_bloom
    ep.slice(372, 404),                  // prev_randao
    u64chunk(ep.slice(404, 412)),        // block_number
    u64chunk(ep.slice(412, 420)),        // gas_limit
    u64chunk(ep.slice(420, 428)),        // gas_used
    u64chunk(ep.slice(428, 436)),        // timestamp
    rootByteList(extraData, 0),          // extra_data
    ep.slice(440, 472),                  // base_fee_per_gas
    ep.slice(472, 504),                  // block_hash
    txListRoot,                          // transactions (leaf 13)
  ]

  if (fork === 'bellatrix') {
    while (leaves.length < 16) leaves.push(ZERO[0])
    return merkleizeExact(leaves)
  }

  leaves.push(wdListRoot)  // withdrawals (leaf 14)

  if (fork === 'capella') {
    leaves.push(ZERO[0])   // pad to 16
    return merkleizeExact(leaves)
  }

  // Deneb and Electra: blob_gas_used (leaf 15) and excess_blob_gas (leaf 16) are in fixed prefix
  leaves.push(u64chunk(ep.slice(512, 520)), u64chunk(ep.slice(520, 528)))

  if (fork === 'deneb') {
    while (leaves.length < 32) leaves.push(ZERO[0])
    return merkleizeExact(leaves)
  }

  // Electra: deposit_requests (17), withdrawal_requests (18), consolidation_requests (19)
  leaves.push(
    rootListDepositRequests(ep.slice(depReqOff, wdReqOff)),
    rootListWithdrawalRequests(ep.slice(wdReqOff, conReqOff)),
    rootListConsolidationRequests(ep.slice(conReqOff)),
  )
  while (leaves.length < 32) leaves.push(ZERO[0])
  return merkleizeExact(leaves)
}

// List helpers for BeaconBlockBody fields
function rootListProposerSlashings(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 416)
  if (n === 0) return mixLen(ZERO[4], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const b = data.slice(i * 416, (i + 1) * 416)
    roots.push(h(rootSignedBeaconBlockHeader(b.slice(0, 208)), rootSignedBeaconBlockHeader(b.slice(208, 416))))
  }
  return mixLen(merkleizeAtDepth(roots, 4), n)
}

function rootListAttesterSlashings(data: Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[1], 0)
  const items = parseVariableList(data)
  const roots = items.map(b => {
    const off1 = readU32LE(b, 0)
    const off2 = readU32LE(b, 4)
    return h(rootIndexedAttestation(b.slice(off1, off2)), rootIndexedAttestation(b.slice(off2)))
  })
  return mixLen(merkleizeAtDepth(roots, 1), roots.length)
}

function rootListAttestations(data: Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[7], 0)
  const roots = parseVariableList(data).map(rootAttestation)
  return mixLen(merkleizeAtDepth(roots, 7), roots.length)
}

function rootListDeposits(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 1240)
  if (n === 0) return mixLen(ZERO[4], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootDeposit(data.slice(i * 1240, (i + 1) * 1240)))
  return mixLen(merkleizeAtDepth(roots, 4), n)
}

function rootListVoluntaryExits(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 112)
  if (n === 0) return mixLen(ZERO[4], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootSignedVoluntaryExit(data.slice(i * 112, (i + 1) * 112)))
  return mixLen(merkleizeAtDepth(roots, 4), n)
}

function rootListBLSToExecChanges(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 172)
  if (n === 0) return mixLen(ZERO[4], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootSignedBLSToExecutionChange(data.slice(i * 172, (i + 1) * 172)))
  return mixLen(merkleizeAtDepth(roots, 4), n)
}

function rootListKZGCommitments(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 48)
  if (n === 0) return mixLen(ZERO[12], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootBLSPubkey(data.slice(i * 48, (i + 1) * 48)))
  return mixLen(merkleizeAtDepth(roots, 12), n)
}

// List[HistoricalSummary, 2^24] (historical_summaries), each entry 64 bytes
function rootListHistoricalSummary(data: Uint8Array): Uint8Array {
  const n = data.length / 64
  if (n === 0) return mixLen(ZERO[24], 0)
  const hs: Uint8Array[] = []
  for (let i = 0; i < n; i++) hs.push(rootHistoricalSummary(data.slice(i * 64, (i + 1) * 64)))
  return mixLen(merkleizeAtDepth(hs, 24), n)
}

// ---------------------------------------------------------------------------
// Electra BeaconState pending types (fields 34–36)
// ---------------------------------------------------------------------------

// PendingDeposit: pubkey[48] withdrawal_credentials[32] amount[8] signature[96] slot[8] = 192 bytes
function rootPendingDeposit(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    rootBLSPubkey(b.slice(0, 48)),
    b.slice(48, 80),
    u64chunk(b.slice(80, 88)),
    rootBLSSignature(b.slice(88, 184)),
    u64chunk(b.slice(184, 192)),
    ZERO[0], ZERO[0], ZERO[0],
  ])
}

// PendingPartialWithdrawal: index[8] amount[8] withdrawable_epoch[8] = 24 bytes
function rootPendingPartialWithdrawal(b: Uint8Array): Uint8Array {
  return merkleizeExact([u64chunk(b.slice(0, 8)), u64chunk(b.slice(8, 16)), u64chunk(b.slice(16, 24)), ZERO[0]])
}

// PendingConsolidation: source_index[8] target_index[8] = 16 bytes
function rootPendingConsolidation(b: Uint8Array): Uint8Array {
  return merkleizeExact([u64chunk(b.slice(0, 8)), u64chunk(b.slice(8, 16))])
}

// MAX_PENDING_DEPOSITS_LIMIT = 2^27, MAX_PENDING_PARTIAL_WITHDRAWALS = 2^27, MAX_PENDING_CONSOLIDATIONS = 2^18
function rootListPendingDeposits(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 192)
  if (n === 0) return mixLen(ZERO[27], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootPendingDeposit(data.slice(i * 192, (i + 1) * 192)))
  return mixLen(merkleizeAtDepth(roots, 27), n)
}
function rootListPendingPartialWithdrawals(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 24)
  if (n === 0) return mixLen(ZERO[27], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootPendingPartialWithdrawal(data.slice(i * 24, (i + 1) * 24)))
  return mixLen(merkleizeAtDepth(roots, 27), n)
}
function rootListPendingConsolidations(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 16)
  if (n === 0) return mixLen(ZERO[18], 0)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootPendingConsolidation(data.slice(i * 16, (i + 1) * 16)))
  return mixLen(merkleizeAtDepth(roots, 18), n)
}

// ---------------------------------------------------------------------------
// Gloas (Glamsterdam) — EIP-7495 ProgressiveContainer / EIP-7916 ProgressiveList
// merkleization + EIP-7732 (ePBS) field set. Serialization is unchanged from the
// prior forks (offsets parse the same); only hash_tree_root changes here.
// ---------------------------------------------------------------------------

// Fork activation by slot (epoch = slot / 32). Determined from the known update
// epoch per chain, NOT from state-structure heuristics. Gloas is the only fork
// whose BeaconState/BeaconBlockBody merkleization this file special-cases; the
// pre-Gloas forks keep their existing serialization-driven detection. A chain not
// listed (or with Gloas not yet scheduled → Infinity) is treated as pre-Gloas.
const GLOAS_FORK_EPOCH: Record<number, number> = {
  1:          Infinity,   // mainnet — not scheduled yet
  11155111:   Infinity,   // sepolia
  17000:      Infinity,   // holesky
  560048:     Infinity,   // hoodi
  7091047534: 1536,       // Platåberget Glamsterdam devnet
}
export function isGloasSlot(chainId: number, slot: number): boolean {
  const e = GLOAS_FORK_EPOCH[chainId]
  return e !== undefined && Math.floor(slot / 32) >= e
}

// merkleize_progressive(chunks, num_leaves=1): 0-terminated sequence of binary
// subtrees with leaf counts 1, 4, 16, … (EIP-7916). Empty → zero.
function merkleizeProgressive(chunks: Uint8Array[], numLeaves = 1): Uint8Array {
  if (chunks.length === 0) return ZERO[0]
  const depth = Math.round(Math.log2(numLeaves))          // numLeaves ∈ {1,4,16,…} = 2^even
  const a = merkleizeAtDepth(chunks.slice(0, numLeaves), depth)
  const b = merkleizeProgressive(chunks.slice(numLeaves), numLeaves * 4)
  return h(a, b)
}
// pack_bits(active_fields) as one 32-byte chunk (≤256 bits).
function activeFieldsChunk(width: number): Uint8Array {
  const o = new Uint8Array(32)
  for (let i = 0; i < width; i++) o[i >> 3] |= 1 << (i & 7)
  return o
}
// hash_tree_root(ProgressiveContainer) = hash(merkleize_progressive(field_roots), pack_bits(active_fields))
function progContainer(fieldRoots: Uint8Array[], width: number): Uint8Array {
  return h(merkleizeProgressive(fieldRoots), activeFieldsChunk(width))
}
// hash_tree_root(ProgressiveList) = mix_in_length(merkleize_progressive(...), len)
function progListComposite(data: Uint8Array, elemSize: number, rootFn: (b: Uint8Array) => Uint8Array): Uint8Array {
  const n = Math.floor(data.length / elemSize)
  const roots: Uint8Array[] = []
  for (let i = 0; i < n; i++) roots.push(rootFn(data.slice(i * elemSize, (i + 1) * elemSize)))
  return mixLen(merkleizeProgressive(roots), n)
}
function progListVariable(data: Uint8Array, rootFn: (b: Uint8Array) => Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[0], 0)
  const roots = parseVariableList(data).map(rootFn)
  return mixLen(merkleizeProgressive(roots), roots.length)
}
function progListU64(data: Uint8Array): Uint8Array { return mixLen(merkleizeProgressive(chunkify(data)), Math.floor(data.length / 8)) }
function progListU8(data: Uint8Array): Uint8Array { return mixLen(merkleizeProgressive(chunkify(data)), data.length) }

// -- Gloas element containers --
// Withdrawal (44): index[8] validator_index[8] address[20] amount[8] → 4 leaves
function rootWithdrawalG(b: Uint8Array): Uint8Array {
  return merkleizeExact([u64chunk(b.slice(0, 8)), u64chunk(b.slice(8, 16)), pad32(b.slice(16, 36)), u64chunk(b.slice(36, 44))])
}
// Builder (93): pubkey[48] version[1] execution_address[20] balance[8] deposit_epoch[8] withdrawable_epoch[8] → 6 fields → 8 leaves
function rootBuilderG(b: Uint8Array): Uint8Array {
  return merkleizeExact([
    rootBLSPubkey(b.slice(0, 48)), pad32(b.slice(48, 49)), pad32(b.slice(49, 69)),
    u64chunk(b.slice(69, 77)), u64chunk(b.slice(77, 85)), u64chunk(b.slice(85, 93)), ZERO[0], ZERO[0],
  ])
}
// BuilderPendingWithdrawal (36): fee_recipient[20] amount[8] builder_index[8] → 3 fields → 4 leaves
function rootBuilderPendingWdG(b: Uint8Array): Uint8Array {
  return merkleizeExact([pad32(b.slice(0, 20)), u64chunk(b.slice(20, 28)), u64chunk(b.slice(28, 36)), ZERO[0]])
}
// BuilderPendingPayment (52): weight[8] withdrawal[36] proposer_index[8] → 3 fields → 4 leaves
function rootBuilderPendingPaymentG(b: Uint8Array): Uint8Array {
  return merkleizeExact([u64chunk(b.slice(0, 8)), rootBuilderPendingWdG(b.slice(8, 44)), u64chunk(b.slice(44, 52)), ZERO[0]])
}
// ExecutionPayloadBid (ProgressiveContainer, width 12). Fixed prefix 188 bytes,
// then blob_kzg_commitments offset[4] @188, execution_requests_root[32] @192.
function rootExecutionPayloadBidG(b: Uint8Array): Uint8Array {
  const blobOff = readU32LE(b, 188)
  const blob = b.slice(blobOff)
  const nComm = Math.floor(blob.length / 48)
  const commRoots: Uint8Array[] = []
  for (let i = 0; i < nComm; i++) commRoots.push(rootBLSPubkey(blob.slice(i * 48, i * 48 + 48))) // KZGCommitment = Bytes48
  const blobRoot = mixLen(merkleizeProgressive(commRoots), nComm) // BlobKzgCommitments is a ProgressiveList in Gloas
  return progContainer([
    b.slice(0, 32), b.slice(32, 64), b.slice(64, 96), b.slice(96, 128),   // parent_block_hash, parent_block_root, block_hash, prev_randao
    pad32(b.slice(128, 148)),                                              // fee_recipient
    u64chunk(b.slice(148, 156)), u64chunk(b.slice(156, 164)), u64chunk(b.slice(164, 172)), // gas_limit, builder_index, slot
    u64chunk(b.slice(172, 180)), u64chunk(b.slice(180, 188)),             // value, execution_payment
    blobRoot, pad32(b.slice(192, 224)),                                   // blob_kzg_commitments, execution_requests_root
  ], 12)
}
// PayloadAttestationData (42): beacon_block_root[32] slot[8] payload_present[1] blob_data_available[1] → 4 leaves
function rootPayloadAttestationDataG(b: Uint8Array): Uint8Array {
  return merkleizeExact([b.slice(0, 32), u64chunk(b.slice(32, 40)), pad32(b.slice(40, 41)), pad32(b.slice(41, 42))])
}
// PayloadAttestation (202, ProgressiveContainer width 3): aggregation_bits BitVector[512](64B) data(42) signature[96]
function rootPayloadAttestationG(b: Uint8Array): Uint8Array {
  return progContainer([h(b.slice(0, 32), b.slice(32, 64)), rootPayloadAttestationDataG(b.slice(64, 106)), rootBLSSignature(b.slice(106, 202))], 3)
}
// ProgressiveBitList (EIP-7916): strip sentinel bit, pack, mix_in_length(merkleize_progressive(chunks), bitCount)
function rootProgressiveBitlist(data: Uint8Array): Uint8Array {
  if (data.length === 0) return mixLen(ZERO[0], 0)
  const lastByte = data[data.length - 1]
  let sentinelBit = 0
  for (let i = 7; i >= 0; i--) { if (lastByte & (1 << i)) { sentinelBit = i; break } }
  const bitCount = (data.length - 1) * 8 + sentinelBit
  const stripped = new Uint8Array(data)
  stripped[stripped.length - 1] = lastByte ^ (1 << sentinelBit)
  return mixLen(merkleizeProgressive(chunkify(stripped)), bitCount)
}
// Gloas Attestation (ProgressiveContainer width 4): aggregation_bits offset[4], data[128], signature[96], committee_bits[8]
function rootAttestationGloas(b: Uint8Array): Uint8Array {
  const offAgg = readU32LE(b, 0)
  return progContainer([rootProgressiveBitlist(b.slice(offAgg)), rootAttestationData(b.slice(4, 132)), rootBLSSignature(b.slice(132, 228)), pad32(b.slice(228, 236))], 4)
}
// Gloas IndexedAttestation (ProgressiveContainer width 3): attesting_indices offset[4], data[128], signature[96]
function rootIndexedAttestationGloas(b: Uint8Array): Uint8Array {
  const offIdx = readU32LE(b, 0)
  return progContainer([progListU64(b.slice(offIdx)), rootAttestationData(b.slice(4, 132)), rootBLSSignature(b.slice(132, 228))], 3)
}
// AttesterSlashing (regular container): attestation_1 offset[4], attestation_2 offset[4]
function rootAttesterSlashingGloas(b: Uint8Array): Uint8Array {
  const off1 = readU32LE(b, 0), off2 = readU32LE(b, 4)
  return h(rootIndexedAttestationGloas(b.slice(off1, off2)), rootIndexedAttestationGloas(b.slice(off2)))
}
// BuilderDepositRequest (184): pubkey[48] withdrawal_credentials[32] amount[8] signature[96] → 4 fields → 4 leaves
function rootBuilderDepositRequest(b: Uint8Array): Uint8Array {
  return merkleizeExact([rootBLSPubkey(b.slice(0, 48)), b.slice(48, 80), u64chunk(b.slice(80, 88)), rootBLSSignature(b.slice(88, 184))])
}
// BuilderExitRequest (68): source_address[20] pubkey[48] → 2 fields
function rootBuilderExitRequest(b: Uint8Array): Uint8Array {
  return h(pad32(b.slice(0, 20)), rootBLSPubkey(b.slice(20, 68)))
}
// Gloas ExecutionRequests (ProgressiveContainer width 5): five ProgressiveLists, five offsets
function rootExecutionRequestsGloas(b: Uint8Array): Uint8Array {
  if (b.length === 0) return progContainer([mixLen(ZERO[0], 0), mixLen(ZERO[0], 0), mixLen(ZERO[0], 0), mixLen(ZERO[0], 0), mixLen(ZERO[0], 0)], 5)
  const o = [readU32LE(b, 0), readU32LE(b, 4), readU32LE(b, 8), readU32LE(b, 12), readU32LE(b, 16), b.length]
  return progContainer([
    progListComposite(b.slice(o[0], o[1]), 192, rootDepositRequest),
    progListComposite(b.slice(o[1], o[2]), 76, rootWithdrawalRequest),
    progListComposite(b.slice(o[2], o[3]), 116, rootConsolidationRequest),
    progListComposite(b.slice(o[3], o[4]), 184, rootBuilderDepositRequest),
    progListComposite(b.slice(o[4], o[5]), 68, rootBuilderExitRequest),
  ], 5)
}

// Full Gloas BeaconState hash_tree_root. Serialization order = 46 fields; fields
// 11,12,15,16,21,34,35,36,38,42,44 are ProgressiveLists; the container itself is a
// ProgressiveContainer (all 46 active). Reuses the pre-Gloas element roots where
// the element type is unchanged.
function computeBeaconStateRootGloas(stateSSZ: Uint8Array): BeaconStateVerification {
  // Walk the fixed section: fixed fields are inline, variable fields are 4-byte offsets.
  const fixed: (number | null)[] = [
    8, 32, 8, 16, 112, 262144, 262144, null, 72, null, 8, null, null, 2097152, 65536, null, null,
    1, 40, 40, 40, null, 24624, 24624, 32, 8, 8, null, 8, 8, 8, 8, 8, 8, null, null, null, 512,
    null, 8, 1024, 3328, null, null, null, 393216,
  ]
  const slice: Uint8Array[] = new Array(46)
  const varIdx: { i: number; off: number }[] = []
  let cur = 0
  for (let i = 0; i < 46; i++) {
    if (fixed[i] === null) { varIdx.push({ i, off: readU32LE(stateSSZ, cur) }); cur += 4 }
    else { slice[i] = stateSSZ.subarray(cur, cur + (fixed[i] as number)); cur += fixed[i] as number }
  }
  for (let k = 0; k < varIdx.length; k++) {
    const start = varIdx[k].off
    const end = k + 1 < varIdx.length ? varIdx[k + 1].off : stateSSZ.length
    slice[varIdx[k].i] = stateSSZ.subarray(start, end)
  }

  const histSummaries = slice[27]
  const fieldRoots: Uint8Array[] = [
    u64chunk(slice[0]), pad32(slice[1]), u64chunk(slice[2]), rootFork(slice[3]),        // 0-3
    rootBeaconBlockHeader(slice[4]), rootVectorRoot8192(slice[5]), rootVectorRoot8192(slice[6]), // 4-6
    rootListRoot_2_24(slice[7]), rootEth1Data(slice[8]), rootListEth1Data(slice[9]), u64chunk(slice[10]), // 7-10
    progListComposite(slice[11], 121, rootValidator),   // 11 validators
    progListU64(slice[12]),                             // 12 balances
    rootVectorBytes32_65536(slice[13]), rootVectorGwei8192(slice[14]),                  // 13-14
    progListU8(slice[15]), progListU8(slice[16]),       // 15-16 participation
    pad32(slice[17]), rootCheckpoint(slice[18]), rootCheckpoint(slice[19]), rootCheckpoint(slice[20]), // 17-20
    progListU64(slice[21]),                             // 21 inactivity_scores
    rootSyncCommittee(slice[22]), rootSyncCommittee(slice[23]),                         // 22-23
    pad32(slice[24]), u64chunk(slice[25]), u64chunk(slice[26]),                         // 24 latest_block_hash, 25-26
    rootListHistoricalSummary(slice[27]),               // 27 historical_summaries
    u64chunk(slice[28]), u64chunk(slice[29]), u64chunk(slice[30]), u64chunk(slice[31]), // 28-31
    u64chunk(slice[32]), u64chunk(slice[33]),           // 32-33
    progListComposite(slice[34], 192, rootPendingDeposit),            // 34
    progListComposite(slice[35], 24, rootPendingPartialWithdrawal),   // 35
    progListComposite(slice[36], 16, rootPendingConsolidation),       // 36
    merkleizeAtDepth(chunkify(slice[37]), 4),           // 37 proposer_lookahead Vector[u64,64]
    progListComposite(slice[38], 93, rootBuilderG),     // 38 builders
    u64chunk(slice[39]),                                // 39 next_withdrawal_builder_index
    merkleizeAtDepth(chunkify(slice[40]), 5),           // 40 execution_payload_availability BitVector[8192]
    (() => { const rs: Uint8Array[] = []; for (let i = 0; i < 64; i++) rs.push(rootBuilderPendingPaymentG(slice[41].subarray(i * 52, i * 52 + 52))); return merkleizeAtDepth(rs, 6) })(), // 41
    progListComposite(slice[42], 36, rootBuilderPendingWdG),          // 42 builder_pending_withdrawals
    rootExecutionPayloadBidG(slice[43]),                // 43 latest_execution_payload_bid
    progListComposite(slice[44], 44, rootWithdrawalG),  // 44 payload_expected_withdrawals
    (() => { const rs: Uint8Array[] = []; for (let i = 0; i < 96; i++) rs.push(merkleizeAtDepth(chunkify(slice[45].subarray(i * 4096, i * 4096 + 4096)), 7)); return merkleizeAtDepth(rs, 7) })(), // 45 ptc_window
  ]
  const computedRoot = hexlify(progContainer(fieldRoots, 46))

  return {
    computedRoot,
    getBlockSummaryRoot(era: number): string | null {
      const offset = era * 64
      if (offset + 64 > histSummaries.length) return null
      return hexlify(histSummaries.slice(offset, offset + 32))
    },
    getBlockRootAtSlot(slot: number): string {
      const idx = slot % 8192
      return hexlify(stateSSZ.slice(176 + idx * 32, 176 + (idx + 1) * 32))  // block_roots is field 5 @ byte 176 (unchanged)
    },
    getHistoricalSummariesBlob(): string {
      let s = ''
      for (let i = 0; i < histSummaries.length; i++) s += String.fromCharCode(histSummaries[i])
      return btoa(s)
    },
    computeHistoricalSummariesFieldProof(): string {
      // Progressive-container field proof not ported; the era-tail fast path is
      // disabled for Gloas (full-state download is used instead), so this is unused.
      throw new Error('historical_summaries field proof not supported for Gloas (use full-state path)')
    },
    getFieldRoots(): string[] { return fieldRoots.map(hexlify) },
  }
}

// ---------------------------------------------------------------------------
// Main: full BeaconState hash_tree_root + historical_summaries extraction
// ---------------------------------------------------------------------------

export interface BeaconStateVerification {
  /** Computed hash_tree_root of the beacon state — compare against the SSZ-verified state_root. */
  computedRoot: string
  /** Extract historical_summaries[era].block_summary_root from the verified state. */
  getBlockSummaryRoot(era: number): string | null
  /** Read block_roots[slot % 8192] from the verified state (0x-hex, 32 bytes). */
  getBlockRootAtSlot(slot: number): string
  /** Raw historical_summaries bytes (N × 64 bytes) as a base64 string. */
  getHistoricalSummariesBlob(): string
  /** Proof from historical_summaries list root → BeaconState root (5-6 sibling hashes, base64). */
  computeHistoricalSummariesFieldProof(): string
  /** Per-field hash_tree_roots (0x-hex), in BeaconState field order. For proof reconstruction/testing. */
  getFieldRoots(): string[]
}

/**
 * Compute hash_tree_root of a Capella/Deneb/Electra/Fulu BeaconState SSZ blob.
 *
 * Correct SSZ fixed-section layout (fields are in serialization order):
 *   [0,        8)       genesis_time (uint64) — INLINE
 *   [8,       40)       genesis_validators_root (Bytes32) — INLINE
 *   [40,      48)       slot (uint64) — INLINE
 *   [48,      64)       fork (Fork, 16 bytes) — INLINE
 *   [64,     176)       latest_block_header (BeaconBlockHeader, 112 bytes) — INLINE
 *   [176,  262320)      block_roots Vector[Root,8192] (262144 bytes) — INLINE (fixed-size Vector)
 *   [262320, 524464)    state_roots Vector[Root,8192] (262144 bytes) — INLINE
 *   [524464, 524468)    historical_roots OFFSET — 4-byte pointer
 *   [524468, 524540)    eth1_data (Eth1Data, 72 bytes) — INLINE
 *   [524540, 524544)    eth1_data_votes OFFSET
 *   [524544, 524552)    eth1_deposit_index (uint64) — INLINE
 *   [524552, 524556)    validators OFFSET
 *   [524556, 524560)    balances OFFSET
 *   [524560, 2621712)   randao_mixes Vector[Root,65536] (2097152 bytes) — INLINE
 *   [2621712, 2687248)  slashings Vector[Gwei,8192] (65536 bytes) — INLINE
 *   [2687248, 2687252)  previous_epoch_participation OFFSET
 *   [2687252, 2687256)  current_epoch_participation OFFSET
 *   [2687256, 2687257)  justification_bits (Bitvector[4], 1 byte) — INLINE
 *   [2687257, 2687297)  previous_justified_checkpoint (Checkpoint, 40 bytes) — INLINE
 *   [2687297, 2687337)  current_justified_checkpoint (Checkpoint, 40 bytes) — INLINE
 *   [2687337, 2687377)  finalized_checkpoint (Checkpoint, 40 bytes) — INLINE
 *   [2687377, 2687381)  inactivity_scores OFFSET
 *   [2687381, 2712005)  current_sync_committee (SyncCommittee, 24624 bytes) — INLINE
 *   [2712005, 2736629)  next_sync_committee (SyncCommittee, 24624 bytes) — INLINE
 *   [2736629, 2736633)  latest_execution_payload_header OFFSET
 *   [2736633, 2736641)  next_withdrawal_index (uint64) — INLINE
 *   [2736641, 2736649)  next_withdrawal_validator_index (uint64) — INLINE
 *   [2736649, 2736653)  historical_summaries OFFSET
 *
 * Electra/Fulu appends 9 more fields at [2736653..):
 *   [2736653, 2736661)  deposit_requests_start_index (uint64) — INLINE
 *   [2736661, 2736669)  deposit_balance_to_consume (uint64) — INLINE
 *   [2736669, 2736677)  exit_balance_to_consume (uint64) — INLINE
 *   [2736677, 2736685)  earliest_exit_epoch (uint64) — INLINE
 *   [2736685, 2736693)  consolidation_balance_to_consume (uint64) — INLINE
 *   [2736693, 2736701)  earliest_consolidation_epoch (uint64) — INLINE
 *   [2736701, 2736705)  pending_deposits OFFSET
 *   [2736705, 2736709)  pending_partial_withdrawals OFFSET
 *   [2736709, 2736713)  pending_consolidations OFFSET
 *
 * Fixed prefix size: Capella/Deneb = 2736653, Electra/Fulu = 2736713.
 * Detection: the historical_roots offset stored at [524464,524468) equals the fixed prefix size.
 */
export function computeBeaconStateRoot(stateSSZ: Uint8Array, fork?: 'gloas'): BeaconStateVerification {
  if (fork === 'gloas') return computeBeaconStateRootGloas(stateSSZ)
  if (stateSSZ.length < 2736653) throw new Error('BeaconState SSZ too short to parse')

  // historical_roots is the first variable field; its stored offset equals the total fixed-prefix size.
  const fixedPrefixSize = readU32LE(stateSSZ, 524464)
  const isElectra = fixedPrefixSize >= 2736713

  const isFulu = fixedPrefixSize >= 2737225
  console.log(`[w3] computeBeaconStateRoot: stateLen=${stateSSZ.length} fixedPrefixSize=${fixedPrefixSize} isElectra=${isElectra} isFulu=${isFulu}`)

  // ── Variable-field offset pointers ─────────────────────────────────────
  const offHistoricalRoots = fixedPrefixSize          // same value we just read
  const offEth1DataVotes   = readU32LE(stateSSZ, 524540)
  const offValidators      = readU32LE(stateSSZ, 524552)
  const offBalances        = readU32LE(stateSSZ, 524556)
  const offPrevPart        = readU32LE(stateSSZ, 2687248)
  const offCurrPart        = readU32LE(stateSSZ, 2687252)
  const offInactivity      = readU32LE(stateSSZ, 2687377)
  const offExecHeader      = readU32LE(stateSSZ, 2736629)
  const offHistSummaries   = readU32LE(stateSSZ, 2736649)

  const offPendingDeposits  = isElectra ? readU32LE(stateSSZ, 2736701) : stateSSZ.length
  const offPendingPartialWd = isElectra ? readU32LE(stateSSZ, 2736705) : stateSSZ.length
  const offPendingConsolid  = isElectra ? readU32LE(stateSSZ, 2736709) : stateSSZ.length

  // ── Slice variable fields ───────────────────────────────────────────────
  // Variable fields are stored in field-index order after the fixed section.
  // Each field's data runs from its own offset to the next variable field's offset.
  const historicalRoots   = stateSSZ.slice(offHistoricalRoots, offEth1DataVotes)
  const eth1DataVotes     = stateSSZ.slice(offEth1DataVotes,   offValidators)
  const validators        = stateSSZ.slice(offValidators,      offBalances)
  const balances          = stateSSZ.slice(offBalances,        offPrevPart)
  const prevParticipation = stateSSZ.slice(offPrevPart,        offCurrPart)
  const currParticipation = stateSSZ.slice(offCurrPart,        offInactivity)
  const inactivityScores  = stateSSZ.slice(offInactivity,      offExecHeader)
  const execPayloadHeader = stateSSZ.slice(offExecHeader,      offHistSummaries)
  const histSummaries     = stateSSZ.slice(offHistSummaries,   offPendingDeposits)
  const pendingDeposits   = stateSSZ.slice(offPendingDeposits,  offPendingPartialWd)
  const pendingPartialWd  = stateSSZ.slice(offPendingPartialWd, offPendingConsolid)
  const pendingConsolid   = stateSSZ.slice(offPendingConsolid)

  // ── Field roots (in BeaconState field order) ────────────────────────────
  const fieldRoots: Uint8Array[] = [
    u64chunk(stateSSZ.slice(0, 8)),                             // 0  genesis_time
    stateSSZ.slice(8, 40),                                      // 1  genesis_validators_root
    u64chunk(stateSSZ.slice(40, 48)),                           // 2  slot
    rootFork(stateSSZ.slice(48, 64)),                           // 3  fork
    rootBeaconBlockHeader(stateSSZ.slice(64, 176)),             // 4  latest_block_header
    rootVectorRoot8192(stateSSZ.slice(176, 262320)),            // 5  block_roots
    rootVectorRoot8192(stateSSZ.slice(262320, 524464)),         // 6  state_roots
    rootListRoot_2_24(historicalRoots),                         // 7  historical_roots
    rootEth1Data(stateSSZ.slice(524468, 524540)),               // 8  eth1_data
    rootListEth1Data(eth1DataVotes),                            // 9  eth1_data_votes
    u64chunk(stateSSZ.slice(524544, 524552)),                   // 10 eth1_deposit_index
    rootListValidator(validators),                              // 11 validators
    rootListGwei(balances),                                     // 12 balances
    rootVectorBytes32_65536(stateSSZ.slice(524560, 2621712)),   // 13 randao_mixes
    rootVectorGwei8192(stateSSZ.slice(2621712, 2687248)),       // 14 slashings
    rootListParticipation(prevParticipation),                   // 15 previous_epoch_participation
    rootListParticipation(currParticipation),                   // 16 current_epoch_participation
    pad32(stateSSZ.slice(2687256, 2687257)),                    // 17 justification_bits
    rootCheckpoint(stateSSZ.slice(2687257, 2687297)),           // 18 previous_justified_checkpoint
    rootCheckpoint(stateSSZ.slice(2687297, 2687337)),           // 19 current_justified_checkpoint
    rootCheckpoint(stateSSZ.slice(2687337, 2687377)),           // 20 finalized_checkpoint
    rootListUint64(inactivityScores),                           // 21 inactivity_scores
    rootSyncCommittee(stateSSZ.slice(2687381, 2712005)),        // 22 current_sync_committee
    rootSyncCommittee(stateSSZ.slice(2712005, 2736629)),        // 23 next_sync_committee
    rootExecutionPayloadHeader(execPayloadHeader),              // 24 latest_execution_payload_header
    u64chunk(stateSSZ.slice(2736633, 2736641)),                 // 25 next_withdrawal_index
    u64chunk(stateSSZ.slice(2736641, 2736649)),                 // 26 next_withdrawal_validator_index
    rootListHistoricalSummary(histSummaries),                   // 27 historical_summaries
  ]

  if (isElectra) {
    fieldRoots.push(
      u64chunk(stateSSZ.slice(2736653, 2736661)),               // 28 deposit_requests_start_index
      u64chunk(stateSSZ.slice(2736661, 2736669)),               // 29 deposit_balance_to_consume
      u64chunk(stateSSZ.slice(2736669, 2736677)),               // 30 exit_balance_to_consume
      u64chunk(stateSSZ.slice(2736677, 2736685)),               // 31 earliest_exit_epoch
      u64chunk(stateSSZ.slice(2736685, 2736693)),               // 32 consolidation_balance_to_consume
      u64chunk(stateSSZ.slice(2736693, 2736701)),               // 33 earliest_consolidation_epoch
      rootListPendingDeposits(pendingDeposits),                  // 34 pending_deposits
      rootListPendingPartialWithdrawals(pendingPartialWd),       // 35 pending_partial_withdrawals
      rootListPendingConsolidations(pendingConsolid),            // 36 pending_consolidations
    )
  }

  if (isFulu) {
    // Fulu adds one new fixed field: Vector[ValidatorIndex, 64] = 512 bytes inline at [2736713, 2737225)
    // hash_tree_root(Vector[uint64, 64]) = merkleizeExact(pack into 16 chunks of 32 bytes)
    fieldRoots.push(merkleizeExact(chunkify(stateSSZ.slice(2736713, 2737225)))) // 37 latest_il_committee
  }

  // Capella/Deneb: 28 fields → pad to 32 leaves
  // Electra: 37 fields → pad to 64 leaves
  // Fulu: 38 fields → pad to 64 leaves
  const targetLeaves = isElectra ? 64 : 32
  while (fieldRoots.length < targetLeaves) fieldRoots.push(ZERO[0])
  const computedRoot = hexlify(merkleizeExact(fieldRoots))

  const nHistSummaries = Math.floor(histSummaries.length / 64)
  console.log(`[w3] historical_summaries count = ${nHistSummaries} (CAPELLA_ERA = anchorEra - ${nHistSummaries})`)

  return {
    computedRoot,
    getBlockSummaryRoot(era: number): string | null {
      const offset = era * 64
      if (offset + 64 > histSummaries.length) return null
      return hexlify(histSummaries.slice(offset, offset + 32))
    },
    getBlockRootAtSlot(slot: number): string {
      const idx = slot % 8192
      return hexlify(stateSSZ.slice(176 + idx * 32, 176 + (idx + 1) * 32))
    },
    getHistoricalSummariesBlob(): string {
      let s = ''
      for (let i = 0; i < histSummaries.length; i++) s += String.fromCharCode(histSummaries[i])
      return btoa(s)
    },
    computeHistoricalSummariesFieldProof(): string {
      const sibs = merkleProofExact(fieldRoots, 27)
      const buf = new Uint8Array(sibs.length * 32)
      sibs.forEach((s, i) => buf.set(s, i * 32))
      return btoa(String.fromCharCode(...buf))
    },
    getFieldRoots(): string[] {
      return fieldRoots.map(hexlify)
    },
  }
}

/**
 * Verify the historical_summaries field proof produced by computeHistoricalSummariesFieldProof.
 *
 * Re-derives hash_tree_root(historical_summaries) from the cached blob, then walks the
 * 5-6 sibling hashes up to the BeaconState root. Covers all eras in one proof.
 */
export function verifyHistoricalSummariesFieldProof(
  histSummariesBlob: string,  // base64, N × 64 bytes
  fieldProofB64: string,       // base64, 5-6 × 32 bytes
  stateRootHex: string,
): boolean {
  const raw = Uint8Array.from(atob(histSummariesBlob), c => c.charCodeAt(0))
  const n = Math.floor(raw.length / 64)
  if (n === 0) return false
  // Recompute historical_summaries list root from the cached entries
  const hs: Uint8Array[] = []
  for (let i = 0; i < n; i++) hs.push(h(raw.slice(i * 64, i * 64 + 32), raw.slice(i * 64 + 32, i * 64 + 64)))
  let node = mixLen(merkleizeAtDepth(hs, 24), n)
  // Walk up the BeaconState field tree from position 27
  const proof = Uint8Array.from(atob(fieldProofB64), c => c.charCodeAt(0))
  const fieldDepth = proof.length / 32
  let idx = 27
  for (let d = 0; d < fieldDepth; d++) {
    const sib = proof.slice(d * 32, (d + 1) * 32)
    node = idx % 2 === 0 ? h(node, sib) : h(sib, node)
    idx >>= 1
  }
  return hexlify(node).toLowerCase() === stateRootHex.toLowerCase()
}

/** hash_tree_root(SyncCommittee): pubkeys Vector[BLSPubkey,512] + aggregate_pubkey. */
export function computeSyncCommitteeRoot(committeeSSZ: Uint8Array): string {
  return hexlify(rootSyncCommittee(committeeSSZ))
}

/** SHA-256 of two 32-byte nodes — for building node(16-23) / node(22-23) from LC siblings. */
export function hashNodes(a: Uint8Array, b: Uint8Array): Uint8Array {
  return h(a, b)
}

/**
 * Reconstruct hash_tree_root(BeaconState) from a historical_summaries blob + the three
 * top field-tree siblings, WITHOUT the full state. Anchor-agnostic: the caller derives
 *   - node(0-15), node(32-63) ← LC current_sync_committee_branch[4]/[5] (or next_sc_branch)
 *   - node(16-23)             ← hashNodes(node16-19, hashNodes(node20-21, node22-23)),
 *                               where node22-23 = hashNodes(scRoot(current), scRoot(next))
 *   - node(28-31), leaf 26, next_withdrawal_index (leaf 25) ← anchor state fixed section (early-abort)
 *   - execution_payload_header root (leaf 24) ← blinded block
 * All inputs must come from the SAME anchor slot (finalized, so EIP-4788 can confirm it).
 * The caller MUST verify the returned root against a Helios/4788-anchored beacon header
 * (this reconstruction is trustless only once that anchor check passes — it fails closed).
 */
export function reconstructStateRootFromHistSummaries(
  histSummariesBlob: Uint8Array,   // N×64 bytes
  node0_15: Uint8Array,            // 32-byte sibling (validators subtree)
  node16_23: Uint8Array,           // 32-byte sibling
  node32_63: Uint8Array,           // 32-byte sibling
  fixedSection: Uint8Array,        // first ≥2_736_685 bytes of the anchor state SSZ
  execHeaderRoot: Uint8Array,      // 32-byte hash_tree_root(latest_execution_payload_header)
): { stateRoot: string; fieldProof: string } | null {
  if (node0_15.length !== 32 || node16_23.length !== 32 || node32_63.length !== 32 || fixedSection.length < 2_736_685) return null

  const leaf25    = u64chunk(fixedSection.slice(2736633, 2736641))  // next_withdrawal_index
  const leaf26    = u64chunk(fixedSection.slice(2736641, 2736649))  // next_withdrawal_validator_index
  const node28_31 = h(
    h(u64chunk(fixedSection.slice(2736653, 2736661)), u64chunk(fixedSection.slice(2736661, 2736669))),
    h(u64chunk(fixedSection.slice(2736669, 2736677)), u64chunk(fixedSection.slice(2736677, 2736685))),
  )
  const node24_25 = h(execHeaderRoot, leaf25)

  // leaf 27: hash_tree_root(historical_summaries) = mix_in_length(merkleize(entry_roots, 24), N)
  const n = Math.floor(histSummariesBlob.length / 64)
  if (n === 0) return null
  const entryRoots: Uint8Array[] = []
  for (let i = 0; i < n; i++)
    entryRoots.push(h(histSummariesBlob.slice(i * 64, i * 64 + 32), histSummariesBlob.slice(i * 64 + 32, i * 64 + 64)))
  let node = mixLen(merkleizeAtDepth(entryRoots, 24), n)

  // Walk up the BeaconState field tree from field index 27. These 6 siblings ARE the
  // historical_summaries field proof (same layout verifyHistoricalSummariesFieldProof expects).
  const sibs = [leaf26, node24_25, node28_31, node16_23, node0_15, node32_63]
  let idx = 27
  for (let d = 0; d < 6; d++) { node = idx % 2 === 0 ? h(node, sibs[d]) : h(sibs[d], node); idx >>= 1 }
  const proofBuf = new Uint8Array(sibs.length * 32)
  sibs.forEach((s, i) => proofBuf.set(s, i * 32))
  return { stateRoot: hexlify(node), fieldProof: btoa(String.fromCharCode(...proofBuf)) }
}

// ---------------------------------------------------------------------------
// BeaconBlockBody hash_tree_root
//
// Verifies hash_tree_root(BeaconBlockBody) == body_root from the SSZ-verified
// beacon block header. Extracts execution_payload.block_hash from the locally
// verified body, closing the final link: body_root → block_hash.
//
// BeaconBlockBody fixed prefix layout (Capella/Deneb, 392 bytes):
//   [0,96)   randao_reveal
//   [96,168) eth1_data
//   [168,200) graffiti
//   [200,204) proposer_slashings offset
//   [204,208) attester_slashings offset
//   [208,212) attestations offset
//   [212,216) deposits offset
//   [216,220) voluntary_exits offset
//   [220,380) sync_aggregate
//   [380,384) execution_payload offset
//   [384,388) bls_to_execution_changes offset
//   [388,392) blob_kzg_commitments offset
// ---------------------------------------------------------------------------

export interface BeaconBlockBodyVerification {
  computedRoot: string
  executionBlockHash: string
}

// Gloas (ePBS) BeaconBlockBody — a ProgressiveContainer of 13 fields. The full
// execution_payload is gone; execution_payload.block_hash moves into
// signed_execution_payload_bid.message.block_hash. All list fields are ProgressiveLists.
function computeBeaconBlockBodyRootGloas(bodySSZ: Uint8Array): BeaconBlockBodyVerification {
  if (bodySSZ.length < 396) throw new Error('Gloas BeaconBlockBody SSZ too short')
  const offPS  = readU32LE(bodySSZ, 200)
  const offAS  = readU32LE(bodySSZ, 204)
  const offAT  = readU32LE(bodySSZ, 208)
  const offD   = readU32LE(bodySSZ, 212)
  const offVE  = readU32LE(bodySSZ, 216)
  const offBLS = readU32LE(bodySSZ, 380)
  const offBid = readU32LE(bodySSZ, 384)
  const offPA  = readU32LE(bodySSZ, 388)
  const offER  = readU32LE(bodySSZ, 392)

  const bid = bodySSZ.slice(offBid, offPA)      // SignedExecutionPayloadBid
  const bidMsgOff = readU32LE(bid, 0)           // message offset; signature is bid[4,100)
  const bidMsg = bid.slice(bidMsgOff)           // ExecutionPayloadBid
  const executionBlockHash = hexlify(bidMsg.slice(64, 96))  // ExecutionPayloadBid.block_hash

  const fieldRoots: Uint8Array[] = [
    rootBLSSignature(bodySSZ.slice(0, 96)),                          // 0 randao_reveal
    rootEth1Data(bodySSZ.slice(96, 168)),                           // 1 eth1_data
    bodySSZ.slice(168, 200),                                        // 2 graffiti
    progListComposite(bodySSZ.slice(offPS, offAS), 416,            // 3 proposer_slashings
      b => h(rootSignedBeaconBlockHeader(b.slice(0, 208)), rootSignedBeaconBlockHeader(b.slice(208, 416)))),
    progListVariable(bodySSZ.slice(offAS, offAT), rootAttesterSlashingGloas),  // 4 attester_slashings (Gloas)
    progListVariable(bodySSZ.slice(offAT, offD), rootAttestationGloas),         // 5 attestations (Gloas)
    progListComposite(bodySSZ.slice(offD, offVE), 1240, rootDeposit),          // 6 deposits
    progListComposite(bodySSZ.slice(offVE, offBLS), 112, rootSignedVoluntaryExit),  // 7 voluntary_exits
    rootSyncAggregate(bodySSZ.slice(220, 380)),                    // 8 sync_aggregate
    progListComposite(bodySSZ.slice(offBLS, offBid), 172, rootSignedBLSToExecutionChange),  // 9 bls_to_execution_changes
    h(rootExecutionPayloadBidG(bidMsg), rootBLSSignature(bid.slice(4, 100))),  // 10 signed_execution_payload_bid
    progListComposite(bodySSZ.slice(offPA, offER), 202, rootPayloadAttestationG),  // 11 payload_attestations
    rootExecutionRequestsGloas(bodySSZ.slice(offER)),              // 12 parent_execution_requests
  ]
  return { computedRoot: hexlify(progContainer(fieldRoots, 13)), executionBlockHash }
}

export function computeBeaconBlockBodyRoot(bodySSZ: Uint8Array, forkHint?: 'gloas'): BeaconBlockBodyVerification {
  if (forkHint === 'gloas') return computeBeaconBlockBodyRootGloas(bodySSZ)
  if (bodySSZ.length < 384) throw new Error('BeaconBlockBody SSZ too short')

  const offPS = readU32LE(bodySSZ, 200)
  // execution_payload offset is always at [380,384) for all forks — read early for fork detection.
  const offEP = readU32LE(bodySSZ, 380)

  // Detect body fork from BeaconBlockBody fixed-prefix size (= value of first variable offset):
  //   Bellatrix: 384  Capella: 388  Deneb: 392  Electra: 396 (adds execution_requests body field)
  // For Deneb vs the rare Electra variant where offPS is also 392, use the EP's extraDataOffset
  // (528 = Deneb EP, 540 = Electra EP with request lists in EP instead of body).
  // On Sepolia/mainnet Electra: offPS=396, epXDO=528 — body is Electra, EP is still Deneb-style.
  let fork: ForkName
  if (offPS <= 384) {
    fork = 'bellatrix'
  } else if (offPS <= 388) {
    fork = 'capella'
  } else if (offPS <= 392) {
    fork = readU32LE(bodySSZ, offEP + 436) >= 540 ? 'electra' : 'deneb'
  } else {
    fork = 'electra'  // offPS=396: execution_requests is a 13th body field
  }

  const offAS = readU32LE(bodySSZ, 204)
  const offAT = readU32LE(bodySSZ, 208)
  const offD  = readU32LE(bodySSZ, 212)
  const offVE = readU32LE(bodySSZ, 216)

  // Trailing variable field offsets; use bodySSZ.length as sentinel for absent fields.
  const offBLS = fork !== 'bellatrix'                    ? readU32LE(bodySSZ, 384) : bodySSZ.length
  const offBKC = fork === 'deneb' || fork === 'electra'  ? readU32LE(bodySSZ, 388) : bodySSZ.length
  // execution_requests is a body field only when the fixed prefix is 396 bytes (offPS > 392).
  const offER  = offPS > 392                             ? readU32LE(bodySSZ, 392) : bodySSZ.length

  const ep = bodySSZ.slice(offEP, offBLS)
  if (ep.length < 504) throw new Error('ExecutionPayload too short in BeaconBlockBody')

  // block_hash is at [472,504) in the ExecutionPayload fixed prefix for all forks
  const executionBlockHash = hexlify(ep.slice(472, 504))

  // ExecutionPayload fork is independent of body fork:
  // Sepolia/mainnet Electra uses a Deneb-style EP (extraDataOffset=528, no requests in EP).
  // The requests live in ExecutionRequests, a separate BeaconBlockBody field when offPS > 392.
  const epXDO = readU32LE(bodySSZ, offEP + 436)
  const epFork: ForkName =
    epXDO >= 540 ? 'electra' :
    epXDO >= 528 ? 'deneb' :
    epXDO >= 512 ? 'capella' : 'bellatrix'

  const leaves: Uint8Array[] = [
    rootBLSSignature(bodySSZ.slice(0, 96)),               // 0 randao_reveal
    rootEth1Data(bodySSZ.slice(96, 168)),                 // 1 eth1_data
    bodySSZ.slice(168, 200),                              // 2 graffiti
    rootListProposerSlashings(bodySSZ.slice(offPS, offAS)),
    fork === 'electra'                                    // 4 attester_slashings
      ? rootListAttesterSlashingsElectra(bodySSZ.slice(offAS, offAT))
      : rootListAttesterSlashings(bodySSZ.slice(offAS, offAT)),
    fork === 'electra'                                    // 5 attestations
      ? rootListAttestationsElectra(bodySSZ.slice(offAT, offD))
      : rootListAttestations(bodySSZ.slice(offAT, offD)),
    rootListDeposits(bodySSZ.slice(offD, offVE)),         // 6 deposits
    rootListVoluntaryExits(bodySSZ.slice(offVE, offEP)),  // 7 voluntary_exits
    rootSyncAggregate(bodySSZ.slice(220, 380)),           // 8 sync_aggregate
    rootExecutionPayload(ep, epFork),                     // 9 execution_payload (EP's own fork)
    // 10 bls_to_execution_changes (Capella+)
    fork !== 'bellatrix'
      ? rootListBLSToExecChanges(bodySSZ.slice(offBLS, offBKC)) : ZERO[0],
    // 11 blob_kzg_commitments (Deneb+); ends at offER when execution_requests is a body field
    fork === 'deneb' || fork === 'electra'
      ? rootListKZGCommitments(bodySSZ.slice(offBKC, offER)) : ZERO[0],
    // 12 execution_requests — present only when offPS > 392
    offPS > 392
      ? rootExecutionRequests(bodySSZ.slice(offER)) : ZERO[0],
  ]
  while (leaves.length < 16) leaves.push(ZERO[0])

  return { computedRoot: hexlify(merkleizeExact(leaves)), executionBlockHash }
}

// ---------------------------------------------------------------------------
// Blinded BeaconBlockBody hash_tree_root — from JSON
//
// A blinded block replaces execution_payload with execution_payload_header. By
// SSZ construction hash_tree_root(body) is identical either way — the header's
// transactions_root/withdrawals_root ARE hash_tree_root of the omitted lists —
// so a blinded block yields the same body_root while being ~30x smaller and
// carrying block_hash directly. This lets us verify a historical block's
// execution hash from the JSON blinded block that gateways like publicnode will
// serve, without needing raw SSZ (which they refuse) and without the transaction
// list (the bulk of the bytes and the fiddliest encoding).
//
// We serialize each JSON body field back to its canonical SSZ bytes and feed the
// existing (tested) hash_tree_root helpers, then merkleize the 13 field roots.
// Verified against the beacon header's body_root, so any serialization bug fails
// closed (mismatch → rejection), never a false accept.
// ---------------------------------------------------------------------------

interface JsonObj { [k: string]: any }

const hx = (s: string): Uint8Array => getBytes(s)

// uint(n) → little-endian, `bytes` wide. Values arrive as decimal strings.
function uintLE(dec: string | number | bigint, bytes: number): Uint8Array {
  let v = BigInt(dec)
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}

function cat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrs) total += a.length
  const out = new Uint8Array(total)
  let p = 0
  for (const a of arrs) { out.set(a, p); p += a.length }
  return out
}

// SSZ variable-length list wire format: uint32-LE offset table + concatenated
// element bytes. Empty list → empty bytes (helpers treat that as the zero root).
function serVarList(elems: Uint8Array[]): Uint8Array {
  if (elems.length === 0) return new Uint8Array(0)
  const head = elems.length * 4
  const parts: Uint8Array[] = []
  let cur = head
  for (const e of elems) { parts.push(uintLE(cur, 4)); cur += e.length }
  return cat(...parts, ...elems)
}
// Fixed-size element list: just concatenate.
const serFixedList = (elems: Uint8Array[]): Uint8Array => cat(...elems)

// --- element serializers (JSON → SSZ) ---

const serBBH = (j: JsonObj): Uint8Array =>            // BeaconBlockHeader, 112
  cat(uintLE(j.slot, 8), uintLE(j.proposer_index, 8), hx(j.parent_root), hx(j.state_root), hx(j.body_root))
const serSignedBBH = (j: JsonObj): Uint8Array =>      // 208
  cat(serBBH(j.message), hx(j.signature))
const serProposerSlashing = (j: JsonObj): Uint8Array => // 416
  cat(serSignedBBH(j.signed_header_1), serSignedBBH(j.signed_header_2))

const serAttData = (j: JsonObj): Uint8Array =>        // AttestationData, 128
  cat(uintLE(j.slot, 8), uintLE(j.index, 8), hx(j.beacon_block_root),
      uintLE(j.source.epoch, 8), hx(j.source.root), uintLE(j.target.epoch, 8), hx(j.target.root))

// Electra Attestation (variable): [agg_bits_off(4)][data(128)][sig(96)][committee_bits(8)] + agg_bits
const serAttestationElectra = (j: JsonObj): Uint8Array =>
  cat(uintLE(236, 4), serAttData(j.data), hx(j.signature), hx(j.committee_bits), hx(j.aggregation_bits))

// IndexedAttestation (variable): [indices_off(4)][data(128)][sig(96)] + indices(u64 each)
const serIndexedAtt = (j: JsonObj): Uint8Array =>
  cat(uintLE(228, 4), serAttData(j.data), hx(j.signature),
      cat(...(j.attesting_indices as string[]).map(x => uintLE(x, 8))))
// AttesterSlashing (variable): [att1_off(4)][att2_off(4)] + att1 + att2
function serAttesterSlashing(j: JsonObj): Uint8Array {
  const a1 = serIndexedAtt(j.attestation_1), a2 = serIndexedAtt(j.attestation_2)
  return cat(uintLE(8, 4), uintLE(8 + a1.length, 4), a1, a2)
}

const serDeposit = (j: JsonObj): Uint8Array =>        // 1240
  cat(cat(...(j.proof as string[]).map(hx)),
      hx(j.data.pubkey), hx(j.data.withdrawal_credentials), uintLE(j.data.amount, 8), hx(j.data.signature))
const serSignedVoluntaryExit = (j: JsonObj): Uint8Array => // 112
  cat(uintLE(j.message.epoch, 8), uintLE(j.message.validator_index, 8), hx(j.signature))
const serSignedBLSChange = (j: JsonObj): Uint8Array => // 172
  cat(uintLE(j.message.validator_index, 8), hx(j.message.from_bls_pubkey), hx(j.message.to_address), hx(j.signature))

const serDepositRequest = (j: JsonObj): Uint8Array =>       // 192
  cat(hx(j.pubkey), hx(j.withdrawal_credentials), uintLE(j.amount, 8), hx(j.signature), uintLE(j.index, 8))
const serWithdrawalRequest = (j: JsonObj): Uint8Array =>    // 76
  cat(hx(j.source_address), hx(j.validator_pubkey), uintLE(j.amount, 8))
const serConsolidationRequest = (j: JsonObj): Uint8Array => // 116
  cat(hx(j.source_address), hx(j.source_pubkey), hx(j.target_pubkey))
function serExecutionRequests(j: JsonObj | undefined): Uint8Array {
  if (!j) return new Uint8Array(0)
  const dep = serFixedList((j.deposits ?? []).map(serDepositRequest))
  const wd  = serFixedList((j.withdrawals ?? []).map(serWithdrawalRequest))
  const con = serFixedList((j.consolidations ?? []).map(serConsolidationRequest))
  return cat(uintLE(12, 4), uintLE(12 + dep.length, 4), uintLE(12 + dep.length + wd.length, 4), dep, wd, con)
}

// ExecutionPayloadHeader (Deneb-shaped, 17 fields; Electra/Fulu keep this shape —
// the request roots live in the execution_requests body field, not the header).
function serEPH(j: JsonObj): Uint8Array {
  const fixed = cat(
    hx(j.parent_hash), hx(j.fee_recipient), hx(j.state_root), hx(j.receipts_root),
    hx(j.logs_bloom), hx(j.prev_randao), uintLE(j.block_number, 8), uintLE(j.gas_limit, 8),
    uintLE(j.gas_used, 8), uintLE(j.timestamp, 8), uintLE(584, 4), uintLE(j.base_fee_per_gas, 32),
    hx(j.block_hash), hx(j.transactions_root), hx(j.withdrawals_root),
    uintLE(j.blob_gas_used, 8), uintLE(j.excess_blob_gas, 8),
  )
  return cat(fixed, hx(j.extra_data))
}

export function computeBlindedBeaconBlockBodyRoot(body: JsonObj): BeaconBlockBodyVerification {
  const eph = body.execution_payload_header
  if (!eph?.block_hash) throw new Error('blinded body missing execution_payload_header.block_hash')

  const e1 = body.eth1_data
  const leaves: Uint8Array[] = [
    rootBLSSignature(hx(body.randao_reveal)),                                   // 0 randao_reveal
    rootEth1Data(cat(hx(e1.deposit_root), uintLE(e1.deposit_count, 8), hx(e1.block_hash))), // 1 eth1_data
    hx(body.graffiti),                                                          // 2 graffiti
    rootListProposerSlashings(serFixedList((body.proposer_slashings ?? []).map(serProposerSlashing))),
    rootListAttesterSlashingsElectra(serVarList((body.attester_slashings ?? []).map(serAttesterSlashing))),
    rootListAttestationsElectra(serVarList((body.attestations ?? []).map(serAttestationElectra))),
    rootListDeposits(serFixedList((body.deposits ?? []).map(serDeposit))),      // 6 deposits
    rootListVoluntaryExits(serFixedList((body.voluntary_exits ?? []).map(serSignedVoluntaryExit))),
    rootSyncAggregate(cat(hx(body.sync_aggregate.sync_committee_bits), hx(body.sync_aggregate.sync_committee_signature))),
    rootExecutionPayloadHeader(serEPH(eph)),                                    // 9 execution_payload_header
    rootListBLSToExecChanges(serFixedList((body.bls_to_execution_changes ?? []).map(serSignedBLSChange))),
    rootListKZGCommitments(serFixedList((body.blob_kzg_commitments ?? []).map(hx))),
    rootExecutionRequests(serExecutionRequests(body.execution_requests)),       // 12 execution_requests (Electra+)
  ]
  while (leaves.length < 16) leaves.push(ZERO[0])

  return { computedRoot: hexlify(merkleizeExact(leaves)), executionBlockHash: hexlify(hx(eph.block_hash)) }
}

/** hash_tree_root(ExecutionPayloadHeader) from a blinded block's execution_payload_header JSON. */
export function computeExecutionPayloadHeaderRoot(eph: JsonObj): string {
  return hexlify(rootExecutionPayloadHeader(serEPH(eph)))
}
