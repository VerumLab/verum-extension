// Shared primitives used by both beacon-verifier.ts (orchestrator + header/body/anchor
// fetchers) and the four downloader/*.ts strategies. Split out so those two layers
// don't need a circular import between them.

import { sha256, getBytes, hexlify } from 'ethers'

const GENESIS: Record<number, number> = {
  1:        1606824023,
  11155111: 1655733600,
  17000:    1695902400,
  560048:   1742213400,   // hoodi
}

export function timestampToSlot(timestamp: number, chainId: number): number {
  const genesis = GENESIS[chainId]
  if (!genesis) throw new Error(`No beacon genesis time for chain ${chainId}`)
  return Math.floor((timestamp - genesis) / 12)
}

export function slotToTimestamp(slot: number, chainId: number): number {
  return GENESIS[chainId] + slot * 12
}

export function readU32LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)
}

export function sszMerkleize(chunks: Uint8Array[]): Uint8Array {
  let layer = chunks.map(c => c)
  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const pair = new Uint8Array(64)
      pair.set(layer[i], 0)
      pair.set(layer[i + 1] ?? new Uint8Array(32), 32)
      next.push(getBytes(sha256(pair)))
    }
    layer = next
  }
  return layer[0]
}

// Verifies an era's block_roots vector against the historical_summaries value —
// shared by all three root downloader strategies (exec headers / parquet / era file).
export function computeEraBlockSummaryRoot(roots: Uint8Array[]): string {
  const leaves = Array.from({ length: 8192 }, (_, i) => roots[i] ?? new Uint8Array(32))
  return hexlify(sszMerkleize(leaves))
}

// AbortSignal.timeout() is broken in Chrome MV3 service workers; use AbortController + setTimeout.
export function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(id))
}
