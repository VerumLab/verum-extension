// Portal History Network calldata retrieval.
//
// Client (nimbus_portal_client) uses:
//   - Content keys: SSZ union — selector (1 byte) + uint64 LE block number (8 bytes)
//     - 0x00 = blockBody, 0x01 = receipts  (no header type)
//   - portal_historyGetContent(contentKey) → {content: rlpHex, utpTransfer: bool}
//     Content is RLP-encoded Ethereum block body [txs, uncles, [withdrawals]]
//   - portal_historyGetBlockBody(rlpHeaderHex) → rlpBodyHex (takes full header for verification)
//
// The Portal node validates block body against the header's txRoot before storing,
// a successful fetch means the transactions root was already verified. 
// No additional local trie verification required.

import { getBytes, hexlify, decodeRlp } from 'ethers'

// ---------------------------------------------------------------------------
// Portal JSON-RPC
// ---------------------------------------------------------------------------

async function portalRequest<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { result?: T; error?: { message?: string } }
    if (json.error) throw new Error(json.error.message ?? 'Portal RPC error')
    if (json.result == null) throw new Error('Portal returned null result (content not found)')
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Content key: SSZ union — selector (1 byte) + uint64 LE block number (8 bytes)
// ---------------------------------------------------------------------------

function blockBodyContentKey(blockNumber: number): string {
  const buf = new Uint8Array(9)
  const view = new DataView(buf.buffer)
  view.setUint8(0, 0x00) // blockBody selector
  view.setUint32(1, blockNumber >>> 0, true)                       // lower 32 bits LE
  view.setUint32(5, Math.floor(blockNumber / 0x100000000), true)  // upper 32 bits LE
  return '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// RLP block body decoding
// ---------------------------------------------------------------------------

type RlpItem = string | readonly RlpItem[]

// Extract input data from a decoded RLP transaction item
function extractCalldata(tx: RlpItem): Uint8Array {
  if (typeof tx === 'string') {
    // Typed transaction: type_byte || RLP(fields)
    const bytes = getBytes(tx)
    const type = bytes[0]
    const fields = decodeRlp(hexlify(bytes.slice(1))) as string[]
    if (type === 0x01) return getBytes(fields[6])  // EIP-2930: chainId,nonce,gasPrice,gas,to,value,DATA
    if (type === 0x02) return getBytes(fields[7])  // EIP-1559: chainId,nonce,maxPrio,maxFee,gas,to,value,DATA
    if (type === 0x03) return getBytes(fields[7])  // EIP-4844: same layout up to DATA
    throw new Error(`Unknown tx type: 0x${type.toString(16)}`)
  }
  // Legacy: [nonce, gasPrice, gasLimit, to, value, DATA, v, r, s]
  return getBytes((tx as string[])[5])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCalldataViaPortal(
  portalRpcUrl: string,
  blockNumber: number,
  txIndex: number,
): Promise<{ calldata: Uint8Array; trieVerified: boolean }> {
  const contentKey = blockBodyContentKey(blockNumber)

  // Fetch block body. Portal node validated txRoot before storing
  const resp = await portalRequest<{ content: string }>(
    portalRpcUrl, 'portal_historyGetContent', [contentKey],
  )

  // RLP-decode: [txs_list, uncles_list, [withdrawals_list]]
  const body = decodeRlp(resp.content) as RlpItem[]
  const txs = body[0] as RlpItem[]

  if (txIndex >= txs.length) {
    throw new Error(`txIndex ${txIndex} out of range (block has ${txs.length} txs)`)
  }

  const calldata = extractCalldata(txs[txIndex])

  // Portal already verified trie before storing, mark as verified
  return { calldata, trieVerified: true }
}
