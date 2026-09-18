// ENS (.eth), WNS (.wei) and GNS (.gwei) name resolution for w3:// URLs.
//
// Record layout (set via the name app or scripts/set-name.js):
//   text record "w3" = JSON array: [[blockNumber, txIndex], ...]
//
// The chain is determined by the URL's traifix, eling suf.g. w3://myapp.eth:11155111
// uses that chains (Sepolia) ENS/WNS/GNS. Chain ID is NOT stored in the record.

import { keccak256, concat, getBytes, toUtf8Bytes, hexlify, type BytesLike } from 'ethers'
import type { IVerifiedRpc } from '../rpc/light-client.js'

// Same address on mainnet and Sepolia
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

// NameNFT contract — same address on mainnet and Sepolia
const GNS_REGISTRY = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'
const WNS_REGISTRY = '0x0000000000696760E15f265e828DB644A0c242EB'

export interface TxRef {
  blockNumber: number
  txIndex: number
}

export interface EnsResolution {
  chunks: TxRef[]
}

// ---------------------------------------------------------------------------
// Namehash  (EIP-137)
// ---------------------------------------------------------------------------

function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32)
  if (!name) return node
  for (const label of name.split('.').reverse()) {
    const labelHash = getBytes(keccak256(toUtf8Bytes(label)))
    node = getBytes(keccak256(concat([node, labelHash])))
  }
  return node
}

// ---------------------------------------------------------------------------
// Low-level ABI helpers
// ---------------------------------------------------------------------------

function pad32(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

function encodeUint256(n: number): Uint8Array {
  const hex = n.toString(16).padStart(64, '0')
  return getBytes('0x' + hex)
}

async function ethCall(rpc: IVerifiedRpc, to: string, data: BytesLike): Promise<string> {
  return rpc.request<string>('eth_call', [{ to, data: hexlify(data) }, 'finalized'])
}

// resolver(bytes32 node) → address
async function getResolver(rpc: IVerifiedRpc, node: Uint8Array): Promise<string | null> {
  const selector = getBytes('0x0178b8bf')
  const result = await ethCall(rpc, ENS_REGISTRY, concat([selector, pad32(node)]))
  const addr = '0x' + result.slice(-40)
  if (/^0x0+$/.test(addr)) return null
  return addr
}

// text(bytes32 node, string key) → string
async function getText(rpc: IVerifiedRpc, resolver: string, node: Uint8Array, key: string): Promise<string | null> {
  const selector = getBytes('0x59d1d43c')
  const keyBytes = toUtf8Bytes(key)
  // ABI: node (32) + offset to string (32, value=0x40) + string length (32) + string bytes (padded to 32-boundary)
  const paddedLen = Math.ceil(keyBytes.length / 32) * 32
  const keyPadded = new Uint8Array(paddedLen)
  keyPadded.set(keyBytes)
  const data = concat([selector, pad32(node), encodeUint256(0x40), encodeUint256(keyBytes.length), keyPadded])
  const result = await ethCall(rpc, resolver, data)

  if (!result || result === '0x' || result.length < 130) return null
  const hex = result.slice(2)
  // result is ABI-encoded string: offset(32) + length(32) + bytes
  const strOffset = parseInt(hex.slice(0, 64), 16) * 2
  const strLen = parseInt(hex.slice(strOffset, strOffset + 64), 16)
  if (strLen === 0) return null
  return new TextDecoder().decode(getBytes('0x' + hex.slice(strOffset + 64, strOffset + 64 + strLen * 2)))
}

// addr(bytes32 node) → address  (legacy ENSIP-1 selector; coin type 60)
async function getAddr(rpc: IVerifiedRpc, resolver: string, node: Uint8Array): Promise<string | null> {
  const selector = getBytes('0x3b3b57de')
  const result = await ethCall(rpc, resolver, concat([selector, pad32(node)])).catch(() => '0x')
  if (!result || result.length < 66) return null
  const addr = '0x' + result.slice(-40)
  if (/^0x0+$/.test(addr)) return null
  return addr
}

// contenthash(bytes32 node) → bytes.  A non-empty value whose multicodec is IPFS (0xe3)
// or IPNS (0xe5) means the name is served as a traditional web page via IPFS — verum
// can't serve that (it's not on-chain), so such a name should open through its gateway.
async function hasIpfsContenthash(rpc: IVerifiedRpc, resolver: string, node: Uint8Array): Promise<boolean> {
  const selector = getBytes('0xbc1c58d1')
  const result = await ethCall(rpc, resolver, concat([selector, pad32(node)])).catch(() => '0x')
  if (!result || result.length < 130) return false
  const hex = result.slice(2)
  // ABI-encoded bytes: offset(32) + length(32) + data
  const off = parseInt(hex.slice(0, 64), 16) * 2
  const len = parseInt(hex.slice(off, off + 64), 16)
  if (len === 0) return false
  const first = hex.slice(off + 64, off + 66).toLowerCase()   // first byte of the contenthash
  return first === 'e3' || first === 'e5'
}

// True if a name is served via IPFS/IPNS contenthash (should open through a gateway, not
// verum). Resolves the name's resolver first; any failure means "not IPFS" (false).
export async function nameIsIpfs(name: string, rpc: IVerifiedRpc): Promise<boolean> {
  try {
    const node = namehash(name)
    const resolver = await resolverForName(rpc, name, node)
    return await hasIpfsContenthash(rpc, resolver, node)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Resolver selection — honors each TLD's registry model
// ---------------------------------------------------------------------------

// Returns the resolver contract for a name. GNS (.gwei) and WNS (.wei) are their own
// resolvers (the registry contract answers text/addr directly); ENS (.eth, …) needs
// the registry.resolver(node) hop first.
async function resolverForName(rpc: IVerifiedRpc, name: string, node: Uint8Array): Promise<string> {
  const lower = name.toLowerCase()
  if (lower.endsWith('.wei')) return WNS_REGISTRY
  if (lower.endsWith('.gwei')) return GNS_REGISTRY
  const resolver = await getResolver(rpc, node)
  if (!resolver) throw new Error(`No ENS resolver found for "${name}". Is the name registered on this chain?`)
  return resolver
}

// ---------------------------------------------------------------------------
// ERC-6821: name → content contract
// ---------------------------------------------------------------------------

export interface ContractResolution {
  address: string
  chainId?: number      // from a numeric `<chainId>:0x…` contentcontract prefix
  chainLabel?: string   // from a non-numeric EIP-3770 short-name prefix (e.g. "w3q-g")
}

// Parse an ERC-6821 `contentcontract` text value. Accepted forms:
//   0x… (40 hex)              → address on the current chain
//   <chainId>:0x…             → address on a specific chain (e.g. "1:0x…")
//   <shortName>:0x…           → EIP-3770 chain-prefixed (e.g. "eth:0x…", "w3q-g:0x…")
// A chain prefix is preserved (numeric as chainId, otherwise as chainLabel) so the
// caller can detect content that lives on another chain and error — verum verifies
// against Ethereum's Helios anchor, so it can't prove content on a different chain.
function parseContentContract(raw: string): ContractResolution | null {
  const m = raw.match(/0x[0-9a-fA-F]{40}/)
  if (!m) return null
  const address = m[0]
  const prefix = raw.slice(0, m.index).replace(/[:\s]+$/, '')
  if (!prefix) return { address }
  if (/^\d+$/.test(prefix)) return { address, chainId: parseInt(prefix, 10) }
  return { address, chainLabel: prefix }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

// ENS/WNS/GNS re-verification: after phase 1 resolves a name via a plain RPC, the name is
// re-resolved through Helios (trustless, at `finalized`) and the two chunk lists compared.
// Returns true if Helios confirms the same chunks, false if it resolves to definitively
// different non-empty chunks (possible forgery), undefined if Helios couldn't resolve
// (error or empty result — unverified, not proof of forgery).
export function compareEnsChunks(heliosChunks: TxRef[], phase1Chunks: TxRef[]): boolean | undefined {
  if (heliosChunks.length === 0) return undefined
  return heliosChunks.length === phase1Chunks.length
    && heliosChunks.every((c, i) => {
      const p = phase1Chunks[i]
      return c.blockNumber === p.blockNumber && c.txIndex === p.txIndex
    })
}

function serviceName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.wei')) return 'WNS'
  if (lower.endsWith('.gwei')) return 'GNS'
  return 'ENS'
}

// Parse the custom `w3` text record: JSON array of [blockNumber, txIndex] tx refs.
function parseW3Record(service: string, raw: string): TxRef[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error(`${service} "w3" record is not valid JSON: "${raw}"`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${service} "w3" record must be a JSON array, got: "${raw}"`)
  }

  return (parsed as unknown[]).map((entry, i): TxRef => {
    if (!Array.isArray(entry))
      throw new Error(`${service} "w3" record: expected [blockNumber, txIndex] at index ${i}`)
    const [blockNumber, txIndex] = entry as unknown[]
    if (typeof blockNumber !== 'number' || typeof txIndex !== 'number')
      throw new Error(`${service} "w3" record: expected [blockNumber, txIndex] at index ${i}`)
    return { blockNumber, txIndex }
  })
}

export async function resolveEns(
  name: string,
  rpc: IVerifiedRpc,
): Promise<EnsResolution> {
  const service = serviceName(name)
  const node = namehash(name)
  const resolver = await resolverForName(rpc, name, node)

  const raw = await getText(rpc, resolver, node, 'w3').catch((e: unknown) => {
    console.warn(`[w3] getText failed for "${name}":`, (e as Error).message ?? e)
    return null
  })
  if (!raw) throw new Error(`${service} "${name}" has no "w3" text record at the finalized block.`)

  return { chunks: parseW3Record(service, raw) }
}

// ---------------------------------------------------------------------------
// Unified name resolution: `w3` record → tx-calldata content; else ERC-6821
// `contentcontract` (or the addr record) → a contract-served page (5219/8244).
//
// This is the dispatch a w3:// name goes through: existing verum names keep hitting
// the `w3` branch untouched; contract-served names fall through to `contract`.
// ---------------------------------------------------------------------------

export type NameResolution =
  | { kind: 'chunks'; chunks: TxRef[] }
  | { kind: 'contract'; address: string; chainId?: number }

export async function resolveName(
  name: string,
  rpc: IVerifiedRpc,
): Promise<NameResolution> {
  const service = serviceName(name)
  const node = namehash(name)
  const resolver = await resolverForName(rpc, name, node)

  const w3 = await getText(rpc, resolver, node, 'w3').catch(() => null)
  if (w3) return { kind: 'chunks', chunks: parseW3Record(service, w3) }

  // ERC-6821: content contract, with the addr record as fallback.
  const cc = await getText(rpc, resolver, node, 'contentcontract').catch(() => null)
  if (cc) {
    const parsed = parseContentContract(cc)
    if (parsed) return { kind: 'contract', ...parsed }
  }
  const addr = await getAddr(rpc, resolver, node)
  if (addr) return { kind: 'contract', address: addr }

  throw new Error(`${service} "${name}" has no "w3", "contentcontract", or address record at the finalized block.`)
}
