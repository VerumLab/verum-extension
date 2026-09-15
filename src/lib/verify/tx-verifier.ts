// Transaction inclusion proof via Patricia Merkle Trie reconstruction.
//
// All RPC calls go through IVerifiedRpc (Helios), which handles fallbacks,
// retries, and consensus-layer header verification internally.
//
// We still reconstruct the transaction trie ourselves because Helios verifies
// state (stateRoot) but not transaction calldata (transactionsRoot). The
// transactionsRoot returned by Helios via eth_getBlockByNumber IS verified
// against the sync committee — we use it as the anchor to prove our target
// transaction's calldata is authentic.

import { keccak256, getBytes, encodeRlp, toBeArray } from 'ethers'
import type { IVerifiedRpc } from '../rpc/light-client.js'
import type { VerificationResult } from '../../types.js'

// ---------------------------------------------------------------------------
// Minimal Merkle Patricia Trie — build-only, no Node.js deps
// ---------------------------------------------------------------------------

type Nibbles = number[]

function bytesToNibs(b: Uint8Array): Nibbles {
  const n: Nibbles = []
  for (const byte of b) n.push(byte >> 4, byte & 0xf)
  return n
}

function hexPrefix(nibs: Nibbles, isLeaf: boolean): Uint8Array {
  const flag = isLeaf ? 2 : 0
  const even = nibs.length % 2 === 0
  const all = even ? [flag, 0, ...nibs] : [flag + 1, ...nibs]
  const out = new Uint8Array(all.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = (all[2 * i] << 4) | all[2 * i + 1]
  return out
}

function sharedPrefix(a: Nibbles, b: Nibbles): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

// ethers encodeRlp returns a hex string — wrap to get Uint8Array
function rlpEncode(parts: (Uint8Array | Nibbles | string)[]): Uint8Array {
  return getBytes(encodeRlp(parts as Parameters<typeof encodeRlp>[0]))
}

export interface Item { key: Nibbles; val: Uint8Array }
const EMPTY = new Uint8Array(0)

// Returns the child-reference for a subtrie (hash if ≥32 bytes, inline otherwise)
function nodeRef(items: Item[]): Uint8Array {
  if (items.length === 0) return EMPTY
  const rlp = nodeRlp(items)
  return rlp.length >= 32 ? getBytes(keccak256(rlp)) : rlp
}

// Returns the RLP encoding of the node for a non-empty item set
function nodeRlp(items: Item[]): Uint8Array {
  if (items.length === 1) {
    // Leaf: remaining path + value
    return rlpEncode([hexPrefix(items[0].key, true), items[0].val])
  }

  // Shared prefix among all keys?
  let pfx = items[0].key.length
  for (let i = 1; i < items.length && pfx > 0; i++) {
    pfx = Math.min(pfx, sharedPrefix(items[0].key, items[i].key))
  }

  if (pfx > 0) {
    // Extension: shared prefix → recurse
    const prefix = items[0].key.slice(0, pfx)
    const rest = items.map((it) => ({ key: it.key.slice(pfx), val: it.val }))
    return rlpEncode([hexPrefix(prefix, false), nodeRef(rest)])
  }

  // Branch: 16 slots by first nibble + optional value slot
  const groups = new Map<number, Item[]>()
  let branchVal: Uint8Array = EMPTY
  for (const it of items) {
    if (it.key.length === 0) {
      branchVal = it.val
    } else {
      const n = it.key[0]
      if (!groups.has(n)) groups.set(n, [])
      groups.get(n)!.push({ key: it.key.slice(1), val: it.val })
    }
  }
  const slots: Uint8Array[] = []
  for (let i = 0; i < 16; i++) {
    const g = groups.get(i)
    slots.push(g ? nodeRef(g) : EMPTY)
  }
  slots.push(branchVal)
  return rlpEncode(slots)
}

// The transactions root is always keccak256 of the root node RLP
export function computeTrieRoot(items: Item[]): string {
  if (items.length === 0) {
    // keccak256(RLP('')) — the canonical empty trie root
    return '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
  }
  return keccak256(nodeRlp(items))
}

// ---------------------------------------------------------------------------
// Transaction serialization (canonical, all EIP types)
// ---------------------------------------------------------------------------

interface RpcTx {
  hash: string
  blockHash: string
  blockNumber: string
  transactionIndex: string
  type?: string
  nonce: string
  from: string
  to: string | null
  value: string
  gas: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  input: string
  v: string
  r: string
  s: string
  accessList?: { address: string; storageKeys: string[] }[]
  maxFeePerBlobGas?: string
  blobVersionedHashes?: string[]
  chainId?: string
  yParity?: string
  // EIP-7702 (type 4): each entry delegates an EOA's code to `address`.
  authorizationList?: {
    chainId: string
    address: string
    nonce: string
    yParity?: string
    v?: string
    r: string
    s: string
  }[]
}

// Strip leading zeros from a hex number for RLP (keeps 0x → empty, 0x0 → empty)
function h(hex: string | undefined): Uint8Array {
  if (!hex || hex === '0x' || hex === '0x0') return EMPTY
  const clean = hex.length % 2 ? '0x0' + hex.slice(2) : hex
  // Remove leading zero bytes (RLP positive integers have no leading zeros)
  const raw = getBytes(clean)
  let start = 0
  while (start < raw.length - 1 && raw[start] === 0) start++
  return raw.slice(start)
}

function addr(hex: string | null | undefined): Uint8Array {
  return hex ? getBytes(hex) : EMPTY
}

function accessListRlp(list: RpcTx['accessList'] = []): unknown[] {
  return list.map((item) => [
    getBytes(item.address),
    item.storageKeys.map((k) => getBytes(k)),
  ])
}

// EIP-7702 authorization tuple: [chain_id, address, nonce, y_parity, r, s].
// chain_id 0 is legal (the authorization is valid on any chain) and RLP-encodes
// as empty bytes, which h() already produces.
function authorizationListRlp(list: RpcTx['authorizationList'] = []): unknown[] {
  return list.map((a) => [
    h(a.chainId),
    getBytes(a.address),
    h(a.nonce),
    h(a.yParity ?? a.v),
    h(a.r),
    h(a.s),
  ])
}

function serializeTx(tx: RpcTx): Uint8Array {
  const type = tx.type ? parseInt(tx.type, 16) : 0
  const yParity = h(tx.yParity ?? tx.v)

  if (type === 0) {
    return getBytes(
      encodeRlp([h(tx.nonce), h(tx.gasPrice), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), h(tx.v), h(tx.r), h(tx.s)]),
    )
  }
  if (type === 1) {
    const inner = getBytes(
      encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.gasPrice), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList) as Parameters<typeof encodeRlp>[0], yParity, h(tx.r), h(tx.s)]),
    )
    return concat([new Uint8Array([0x01]), inner])
  }
  if (type === 2) {
    const inner = getBytes(
      encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.maxPriorityFeePerGas), h(tx.maxFeePerGas), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList) as Parameters<typeof encodeRlp>[0], yParity, h(tx.r), h(tx.s)]),
    )
    return concat([new Uint8Array([0x02]), inner])
  }
  if (type === 3) {
    const inner = getBytes(
      encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.maxPriorityFeePerGas), h(tx.maxFeePerGas), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList) as Parameters<typeof encodeRlp>[0], h(tx.maxFeePerBlobGas), (tx.blobVersionedHashes ?? []).map(bv => getBytes(bv)), yParity, h(tx.r), h(tx.s)]),
    )
    return concat([new Uint8Array([0x03]), inner])
  }
  // EIP-7702 set-code transaction (Pectra).
  // Same fields as type 2 plus authorization_list before the signature.
  if (type === 4) {
    const inner = getBytes(
      encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.maxPriorityFeePerGas), h(tx.maxFeePerGas), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList) as Parameters<typeof encodeRlp>[0], authorizationListRlp(tx.authorizationList) as Parameters<typeof encodeRlp>[0], yParity, h(tx.r), h(tx.s)]),
    )
    return concat([new Uint8Array([0x04]), inner])
  }
  throw new Error(`Unsupported tx type: ${type}`)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

// ---------------------------------------------------------------------------
// Transaction trie key: RLP(index)
// ---------------------------------------------------------------------------

export function txKey(index: number): Nibbles {
  // RLP of integer index — for 0 this is 0x80 (empty bytes)
  const indexBytes = index === 0 ? EMPTY : toBeArray(index)
  return bytesToNibs(getBytes(encodeRlp(indexBytes)))
}

// ---------------------------------------------------------------------------
// Public API — all RPC calls go through IVerifiedRpc (Helios)
// ---------------------------------------------------------------------------

// Fetch by block number + tx index directly. Derives the tx hash from the
// fetched transaction data.
export async function getVerifiedCalldataByLocation(
  blockNumber: number,
  txIndex: number,
  rpc: IVerifiedRpc,
): Promise<VerificationResult & { block: RpcBlockFull }> {
  const block = await rpc.request<RpcBlockFull>('eth_getBlockByNumber', [
    `0x${blockNumber.toString(16)}`, true,
  ])
  if (!block.transactions[txIndex]) throw new Error(`No tx at index ${txIndex} in block ${blockNumber}`)

  const tx = block.transactions[txIndex]
  const items: Item[] = block.transactions.map((t, i) => ({ key: txKey(i), val: serializeTx(t) }))
  const computedRoot = computeTrieRoot(items)
  const trieVerified = computedRoot.toLowerCase() === block.transactionsRoot.toLowerCase()
  if (!trieVerified) throw new Error(`Transaction trie mismatch in block ${blockNumber}`)

  return {
    verified: true,
    blockNumber,
    blockHash: block.hash,
    blockTimestamp: parseInt(block.timestamp, 16),
    txHash: tx.hash,
    txIndex,
    trieVerified,
    headerVerified: rpc.isHeliosBacked(),
    calldata: getBytes(tx.input),
    block,
  }
}

// ---------------------------------------------------------------------------
// Block header RLP — proves transactionsRoot is authentic given a known blockHash
// ---------------------------------------------------------------------------

export interface RpcBlockFull {
  hash: string
  parentHash: string; sha3Uncles: string; miner: string; stateRoot: string
  transactionsRoot: string; receiptsRoot: string; logsBloom: string
  difficulty: string; number: string; gasLimit: string; gasUsed: string
  timestamp: string; extraData: string; mixHash: string; nonce: string
  baseFeePerGas?: string
  withdrawalsRoot?: string
  blobGasUsed?: string
  excessBlobGas?: string
  parentBeaconBlockRoot?: string
  requestsHash?: string
  blockAccessListHash?: string   // EIP-7928 (Glamsterdam)
  slotNumber?: string            // ePBS (Glamsterdam) — the consensus slot
  transactions: RpcTx[]
}

// Conditional fork fields must appear in exact fork order (London → Shanghai → Cancun).
function encodeBlockHeader(block: RpcBlockFull): Uint8Array {
  const fields: Uint8Array[] = [
    getBytes(block.parentHash), getBytes(block.sha3Uncles), getBytes(block.miner),
    getBytes(block.stateRoot), getBytes(block.transactionsRoot), getBytes(block.receiptsRoot),
    getBytes(block.logsBloom), h(block.difficulty), h(block.number),
    h(block.gasLimit), h(block.gasUsed), h(block.timestamp),
    getBytes(block.extraData), getBytes(block.mixHash), getBytes(block.nonce),
  ]
  if (block.baseFeePerGas !== undefined)         fields.push(h(block.baseFeePerGas))
  if (block.withdrawalsRoot !== undefined)       fields.push(getBytes(block.withdrawalsRoot))
  if (block.blobGasUsed !== undefined)           fields.push(h(block.blobGasUsed))
  if (block.excessBlobGas !== undefined)         fields.push(h(block.excessBlobGas))
  if (block.parentBeaconBlockRoot !== undefined) fields.push(getBytes(block.parentBeaconBlockRoot))
  if (block.requestsHash !== undefined)         fields.push(getBytes(block.requestsHash))
  // Glamsterdam trailing header fields, in order, appended only when present.
  if (block.blockAccessListHash !== undefined)  fields.push(getBytes(block.blockAccessListHash))
  if (block.slotNumber !== undefined)           fields.push(h(block.slotNumber))
  return getBytes(encodeRlp(fields as Parameters<typeof encodeRlp>[0]))
}

// Verify txIndex is authentically included in a beacon-proven block.
// Trust chain: keccak256(RLP(header)) === blockHash → transactionsRoot is authentic
//              computeTrieRoot(txs) === transactionsRoot → tx at txIndex is authentic
export async function verifyTxInBlock(
  blockHash: string,
  txIndex: number,
  execRpcs: string[],
  cachedBlock?: RpcBlockFull,
): Promise<{ txHash: string; calldata: Uint8Array }> {
  let block: RpcBlockFull | null = cachedBlock ?? null
  if (!block) {
    for (const rpc of execRpcs) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBlockByHash', params: [blockHash, true], id: 1 }),
          signal: ctrl.signal,
        })
        if (!res.ok) { clearTimeout(timer); continue }
        const json = await res.json() as { result: RpcBlockFull | null }
        clearTimeout(timer)
        if (json.result) { block = json.result; break }
      } catch { clearTimeout(timer) }
    }
    if (!block) throw new Error(`Could not fetch block ${blockHash} from any exec RPC`)
  }

  const computedHash = keccak256(encodeBlockHeader(block))
  if (computedHash.toLowerCase() !== blockHash.toLowerCase())
    throw new Error(`Block header hash mismatch: computed ${computedHash} ≠ ${blockHash}`)
  console.log(`[w3] Block ${block.number}: header keccak256 ✓`)

  const items: Item[] = block.transactions.map((t, i) => ({ key: txKey(i), val: serializeTx(t) }))
  const computedRoot = computeTrieRoot(items)
  if (computedRoot.toLowerCase() !== block.transactionsRoot.toLowerCase())
    throw new Error(`Tx trie mismatch: computed ${computedRoot} ≠ ${block.transactionsRoot}`)
  console.log(`[w3] Block ${block.number}: tx trie root ✓ (${block.transactions.length} txs)`)

  const tx = block.transactions[txIndex]
  if (!tx) throw new Error(`No tx at index ${txIndex} in block ${blockHash}`)
  console.log(`[w3] Block ${block.number}: tx[${txIndex}] = ${tx.hash} ✓`)

  return { txHash: tx.hash, calldata: getBytes(tx.input) }
}

