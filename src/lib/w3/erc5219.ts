import { w3log } from '../log'
// ERC-5219 / ERC-8244 contract-served content reads for web3:// (ERC-4804) URLs.
//
// A name (or bare address) can point at a contract that *serves* a web page from a
// view call, instead of the tx-calldata model. ERC-4804's resolveMode() selects the
// interface:
//   "5219"  → ERC-5219  request(string[] resource, KeyValue[] params)
//                        → (uint16 statusCode, string body, KeyValue[] headers)
//   else    → ERC-8244  html() → string   (used as a fallback)
//
// The read is a plain view eth_call, so it is a *current-state* read: Helios verifies
// it against the finalized state root at any contract age — no beacon/era path, no 27h
// boundary. The verification (in background.ts) re-runs the same call through Helios at
// the same pinned block and byte-compares the body.

import { Interface, getBytes } from 'ethers'
import type { IVerifiedRpc } from '../rpc/light-client.js'

const iface = new Interface([
  'function resolveMode() view returns (bytes32)',
  'function request(string[] resource, (string key, string value)[] params) view returns (uint16 statusCode, string body, (string key, string value)[] headers)',
  'function html() view returns (string)',
])

export interface ContractContent {
  body: Uint8Array
  contentType: string
  cacheControl?: string   // ERC-5219 header: "immutable" ⇒ pinned artifact, else live
  statusCode?: number
  mode: '5219' | 'html'
}

async function ethCall(rpc: IVerifiedRpc, to: string, data: string, block: string): Promise<string> {
  return rpc.request<string>('eth_call', [{ to, data }, block])
}

// A failed eth_call has two very different meanings that MUST NOT be conflated:
//  - infra error (Helios shut down mid-restart, out of sync, WASM timeout, no RPC) → the read
//    couldn't run; the caller must rethrow so it can retry on a fresh instance. Masking this
//    as "contract has no interface" produces a wrong "not a web3:// content site" verdict.
//  - genuine execution revert / empty return → the contract doesn't implement the interface.
function isInfraError(e: unknown): boolean {
  const m = ((e as Error)?.message ?? '').toLowerCase()
  return m.includes('shut down') || m.includes('out of sync') ||
         m.includes('wasm call timeout') || m.includes('not available') ||
         m.includes('all rpcs failed')
}

// Map the URL path/query onto ERC-5219 resource[] + params[]. "/a/b?x=1&y=2" →
// resource ["a","b"], params [["x","1"],["y","2"]]. Root "/" → resource [].
function resourceParamsFromPath(path: string): { resource: string[]; params: [string, string][] } {
  const qIdx = path.indexOf('?')
  const pathname = qIdx === -1 ? path : path.slice(0, qIdx)
  const query = qIdx === -1 ? '' : path.slice(qIdx + 1)

  const resource = pathname.split('/').filter(Boolean).map(safeDecode)
  const params: [string, string][] = []
  if (query) {
    for (const pair of query.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const k = eq === -1 ? pair : pair.slice(0, eq)
      const v = eq === -1 ? '' : pair.slice(eq + 1)
      params.push([safeDecode(k), safeDecode(v)])
    }
  }
  return { resource, params }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

// resolveMode() → the mode string ("5219", "manual", "auto", …). A contract that
// doesn't implement it (call reverts) is treated as "" and falls through to html().
async function readResolveMode(rpc: IVerifiedRpc, to: string, block: string): Promise<string> {
  try {
    const res = await ethCall(rpc, to, iface.encodeFunctionData('resolveMode', []), block)
    const [raw] = iface.decodeFunctionResult('resolveMode', res)
    const bytes = getBytes(raw as string)
    let end = bytes.length
    while (end > 0 && bytes[end - 1] === 0) end--   // trim right-padding of the bytes32
    return new TextDecoder().decode(bytes.slice(0, end))
  } catch (e) {
    // A contract with no resolveMode() reverts → treat as "" (auto). But an infra error
    // must propagate so the caller retries, not be mistaken for a contract that simply
    // doesn't implement resolveMode.
    if (isInfraError(e)) throw e
    return ''
  }
}

// Fetch a contract-served page at a pinned block. `block` must be a concrete tag both
// the plain and Helios calls agree on (e.g. the finalized block number) so the later
// byte-compare is deterministic even for pages whose state changes block to block.
export async function fetchContractContent(
  rpc: IVerifiedRpc,
  address: string,
  path: string,
  block: string,
): Promise<ContractContent> {
  const mode = await readResolveMode(rpc, address, block)
  w3log(`[w3] erc5219 ${address} resolveMode="${mode}"`)

  // ERC-5219 request(resource, params) → (status, body, headers). Returns null if the
  // contract doesn't implement it (reverts / empty); rethrows infra errors.
  const tryRequest = async (): Promise<ContractContent | null> => {
    const { resource, params } = resourceParamsFromPath(path)
    const data = iface.encodeFunctionData('request', [resource, params])
    let res: string
    try { res = await ethCall(rpc, address, data, block) } catch (e) { if (isInfraError(e)) throw e; return null }
    if (!res || res === '0x') return null
    let decoded
    try { decoded = iface.decodeFunctionResult('request', res) } catch { return null }
    const statusCode = Number(decoded[0])
    const body = decoded[1] as string
    const headers = decoded[2] as Array<{ 0: string; 1: string }>
    let contentType = 'text/html; charset=utf-8'
    let cacheControl: string | undefined
    for (const h of headers) {
      const key = (h[0] ?? '').toLowerCase()
      if (key === 'content-type') contentType = h[1]
      else if (key === 'cache-control') cacheControl = h[1]
    }
    const enc = new TextEncoder().encode(body)
    w3log(`[w3] erc5219 request() ok — ${enc.length} bytes, ct="${contentType}", cc="${cacheControl ?? ''}"`)
    return { body: enc, contentType, cacheControl, statusCode, mode: '5219' }
  }

  // ERC-8244 html() → string (implicitly text/html). Returns null if it reverts/empty.
  const tryHtml = async (): Promise<ContractContent | null> => {
    const data = iface.encodeFunctionData('html', [])
    let res: string
    try { res = await ethCall(rpc, address, data, block) } catch (e) { if (isInfraError(e)) throw e; return null }
    if (!res || res === '0x') return null
    let decoded
    try { decoded = iface.decodeFunctionResult('html', res) } catch { return null }
    const enc = new TextEncoder().encode(decoded[0] as string)
    w3log(`[w3] erc5219 html() ok — ${enc.length} bytes`)
    return { body: enc, contentType: 'text/html; charset=utf-8', mode: 'html' }
  }

  // Prefer request() when resolveMode advertises 5219; otherwise try both interfaces
  // opportunistically — some contracts implement request()/html() without setting
  // resolveMode to "5219" (e.g. docs.zswap.wei reverts on html() but may serve request()).
  const order = mode === '5219' ? [tryRequest, tryHtml] : [tryHtml, tryRequest]
  for (const attempt of order) {
    const r = await attempt()
    if (r) return r
  }

  throw new Error(
    mode === ''
      ? `${address} does not implement ERC-5219 request() or ERC-8244 html() — it may use ERC-4804 auto/manual mode, which verum doesn't support yet.`
      : `${address} is not a web3:// content site — it serves neither ERC-5219 request() nor ERC-8244 html().`,
  )
}
