// Era block_roots via execution headers: fetch ~8192 execution block headers
// (EIP-4788 parentBeaconBlockRoot), build the block_roots vector, and verify
// sszMerkleize(roots) == block_summary_root. Slowest of the three era-root
// strategies but the only one that works for the current/most recent era
// (era files and parquet exports lag behind the chain head).

import { computeEraBlockSummaryRoot, timestampToSlot, slotToTimestamp } from '../beacon-primitives.js'
import { getBytes, hexlify } from 'ethers'

interface ExecBlockHeader {
  number: string
  timestamp: string
  parentBeaconBlockRoot?: string
}

// RPCs that deliver HTTP headers quickly but stall the response body.
// Populated at runtime; individual-block fetches skip these and try them last.
const slowBodyRpcs = new Set<string>()

async function execRpcCall(rpcs: string[], body: object): Promise<unknown> {
  let lastErr: unknown
  const fast = rpcs.filter(r => !slowBodyRpcs.has(r))
  const ordered = fast.length > 0 ? [...fast, ...rpcs.filter(r => slowBodyRpcs.has(r))] : rpcs
  for (const rpc of ordered) {
    let gotHeaders = false
    const ctrl = new AbortController()
    const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 8000)
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      })
      gotHeaders = true
      if (!res.ok) { clearTimeout(timer); throw new Error(`HTTP ${res.status}`) }
      const json = await res.json()
      clearTimeout(timer)
      return json
    } catch (err) { clearTimeout(timer); lastErr = err }
  }
  throw lastErr ?? new Error('All exec RPCs failed')
}

// Fetches a single block by number, trying each RPC until one returns a non-null result.
// Unlike execRpcCall, a null result is treated as "try next RPC" — needed when RPCs
// return null due to rate limiting rather than the block not existing.
async function fetchExecBlock(rpcs: string[], blockNum: number): Promise<ExecBlockHeader | null> {
  const fast = rpcs.filter(r => !slowBodyRpcs.has(r))
  const ordered = fast.length > 0 ? [...fast, ...rpcs.filter(r => slowBodyRpcs.has(r))] : rpcs
  const delays = [0, 800, 1600]
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    for (const rpc of ordered) {
      let gotHeaders = false
      const ctrl = new AbortController()
      const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 8000)
      try {
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_getBlockByNumber',
            params: ['0x' + blockNum.toString(16), false], id: 0,
          }), signal: ctrl.signal,
        })
        gotHeaders = true
        if (!res.ok) { clearTimeout(timer); continue }
        const json = await res.json() as { result: ExecBlockHeader | null }
        clearTimeout(timer)
        if (json.result != null) return json.result
      } catch { clearTimeout(timer) }
    }
  }
  return null
}

// Returns null if no RPC supports batch (response not an array).
async function execBatch(rpcs: string[], requests: object[]): Promise<{ results: { result?: ExecBlockHeader }[]; rpc: string } | null> {
  for (const rpc of rpcs) {
    let gotHeaders = false
    const ctrl = new AbortController()
    const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 25000)
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests), signal: ctrl.signal,
      })
      gotHeaders = true
      if (!res.ok) { clearTimeout(timer); continue }
      const json = await res.json()
      clearTimeout(timer)
      if (Array.isArray(json)) return { results: json as { result?: ExecBlockHeader }[], rpc }
    } catch { clearTimeout(timer) }
  }
  return null
}

async function findBlockAtTimestamp(
  rpcs: string[],
  targetTs: number,
  lo: number,
  hi: number,
): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await execRpcCall(rpcs, {
      jsonrpc: '2.0', method: 'eth_getBlockByNumber',
      params: ['0x' + mid.toString(16), false], id: 0,
    }) as { result: ExecBlockHeader | null }
    if (!r.result) { lo = mid + 1; continue }
    parseInt(r.result.timestamp, 16) < targetTs ? (lo = mid + 1) : (hi = mid)
  }
  return lo
}

export async function findEraBlockRange(
  execRpcs: string[],
  eraStartSlot: number,
  chainId: number,
): Promise<{ startNum: number; endNum: number }> {
  const startTs = slotToTimestamp(eraStartSlot + 1, chainId)
  const endTs   = slotToTimestamp(eraStartSlot + 8193, chainId) // exclusive: one past the last needed slot

  const anchorJson = await execRpcCall(execRpcs, {
    jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 0,
  }) as { result: ExecBlockHeader }
  const anchorNum = parseInt(anchorJson.result.number, 16)
  const anchorTs  = parseInt(anchorJson.result.timestamp, 16)

  const estimatedOffset = Math.round((anchorTs - startTs) / 12)
  const lo = Math.max(0, anchorNum - estimatedOffset * 2)

  console.log(`[w3] findEraBlockRange: anchorNum=${anchorNum} estimatedOffset=${estimatedOffset} lo=${lo}`)

  const [startNum, endNum] = await Promise.all([
    findBlockAtTimestamp(execRpcs, startTs, lo, anchorNum),
    findBlockAtTimestamp(execRpcs, endTs,   lo, anchorNum),
  ])

  console.log(`[w3] Era block range: [${startNum}, ${endNum}) — ${endNum - startNum} blocks`)
  return { startNum, endNum }
}

export async function fetchEraBlockRootsFromExecHeaders(
  execRpcs: string[],
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  startNum: number,
  endNum: number,
  rpcBatchSizes?: Record<string, number>,
): Promise<Uint8Array[]> {
  const eraStartSlot = era * 8192
  const DEFAULT_BATCH = 200
  const LOG_EVERY = 4

  const rawRoots = new Array<Uint8Array | null>(8192).fill(null)
  let cntInEra = 0

  const processItem = (b: ExecBlockHeader | undefined) => {
    if (!b?.timestamp || !b.parentBeaconBlockRoot) return
    const slot = timestampToSlot(parseInt(b.timestamp, 16), chainId)
    const j = slot - eraStartSlot - 1
    if (j < 0 || j >= 8192) return
    rawRoots[j] = getBytes(b.parentBeaconBlockRoot)
    cntInEra++
  }

  const fetchBlocksIndividually = async (rpcs: string[], nums: number[]): Promise<void> => {
    const inflight = new Set<Promise<void>>()
    for (const n of nums) {
      const p: Promise<void> = (async () => {
        processItem((await fetchExecBlock(rpcs, n)) ?? undefined)
      })().then(() => { inflight.delete(p) })
      inflight.add(p)
      if (inflight.size >= 2) await Promise.race(inflight)
    }
    await Promise.all([...inflight])
  }

  const processSegment = async (segStart: number, segEnd: number, primaryRpc: string): Promise<void> => {
    const allRpcs   = [primaryRpc, ...execRpcs.filter(r => r !== primaryRpc)]
    const otherRpcs = execRpcs.filter(r => r !== primaryRpc)
    const host      = new URL(primaryRpc).hostname
    const BATCH     = rpcBatchSizes?.[primaryRpc] ?? DEFAULT_BATCH
    const total     = Math.ceil((segEnd - segStart) / BATCH)
    let done = 0

    for (let n = segStart; n < segEnd; n += BATCH) {
      const blockNums = Array.from({ length: Math.min(BATCH, segEnd - n) }, (_, i) => n + i)
      const requests  = blockNums.map((bn, i) => ({
        jsonrpc: '2.0', method: 'eth_getBlockByNumber',
        params: ['0x' + bn.toString(16), false], id: i,
      }))
      const batchResult = await execBatch([primaryRpc], requests)
        ?? (otherRpcs.length > 0 ? await execBatch(otherRpcs, requests) : null)

      if (batchResult) {
        const { results } = batchResult
        const retryNums: number[] = []
        const byId = new Map<number, ExecBlockHeader | null>()
        for (const item of results) {
          const id = (item as { id?: number }).id
          if (typeof id === 'number') byId.set(id, item.result ?? null)
        }
        if (byId.size > 0) {
          for (const [id, result] of byId.entries()) {
            if (result != null) processItem(result)
            else retryNums.push(blockNums[id])
          }
          for (let i = 0; i < blockNums.length; i++) {
            if (!byId.has(i)) retryNums.push(blockNums[i])
          }
        } else {
          for (let i = 0; i < results.length; i++) {
            if (results[i].result != null) processItem(results[i].result)
            else retryNums.push(blockNums[i])
          }
          for (let i = results.length; i < blockNums.length; i++) retryNums.push(blockNums[i])
        }
        if (retryNums.length > 0) await fetchBlocksIndividually(allRpcs, retryNums)
      } else {
        await fetchBlocksIndividually(allRpcs, blockNums)
      }

      done++
      if (done % LOG_EVERY === 0 || done === total) {
        console.log(`[w3] Era ${era}: ${host} ${done}/${total} batches (${Math.round(done / total * 100)}%) inEra=${cntInEra}`)
      }
    }
  }

  // Split [startNum, endNum) into N parallel segments, one per RPC
  const numSegments = Math.min(execRpcs.length, 4)
  const segmentSize = Math.ceil((endNum - startNum) / numSegments)
  const segments = Array.from({ length: numSegments }, (_, i) => ({
    segStart: startNum + i * segmentSize,
    segEnd:   Math.min(startNum + (i + 1) * segmentSize, endNum),
    rpc:      execRpcs[i % execRpcs.length],
  }))

  console.log(`[w3] Era ${era}: fetching exec headers ${startNum}–${endNum} (${endNum - startNum} blocks, ${numSegments} segments via ${segments.map(s => new URL(s.rpc).hostname).join(', ')})`)

  await Promise.all(segments.map(({ segStart, segEnd, rpc }) => processSegment(segStart, segEnd, rpc)))

  console.log(`[w3] rawRoots[0]=${rawRoots[0] ? hexlify(rawRoots[0]) : 'null'} rawRoots[8191]=${rawRoots[8191] ? hexlify(rawRoots[8191]) : 'null'}`)

  // Backward-fill missed beacon slots: rawRoots[k]=null means slot eraStartSlot+k+1 was missed;
  // correct block_roots[k] = root of last non-missed block at or before that slot = next non-null to the right.
  // Special case: if rawRoots[8191] is null (slot eraStart+8192 missed), we can't recover block_roots[8191]
  // from rawRoots alone — the exec block at endNum has pbbr = block_roots[8191], so fetch it as the seed.
  let seed: Uint8Array
  if (rawRoots[8191] !== null) {
    seed = rawRoots[8191]
  } else {
    const nextBlock = await fetchExecBlock(execRpcs, endNum)
    seed = nextBlock?.parentBeaconBlockRoot
      ? getBytes(nextBlock.parentBeaconBlockRoot)
      : rawRoots.findLast(r => r !== null) ?? new Uint8Array(32)
    console.log(`[w3] rawRoots[8191] null — fetched seed from exec block ${endNum}: ${nextBlock?.parentBeaconBlockRoot ?? 'null'}`)
  }

  const roots: Uint8Array[] = new Array(8192)
  let last = seed
  for (let j = 8191; j >= 0; j--) {
    if (rawRoots[j] !== null) last = rawRoots[j]!
    roots[j] = last
  }

  const filled = rawRoots.filter(r => r === null).length
  console.log(`[w3] Era ${era}: ${cntInEra} headers mapped, ${filled}/8192 backward-filled`)
  console.log(`[w3] roots[0]=${hexlify(roots[0])} roots[8191]=${hexlify(roots[8191])}`)

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase())
    throw new Error(
      `Era ${era}: computed block_summary_root ${computed} ≠ historical_summaries value ${expectedBlockSummaryRoot}`,
    )
  console.log(`[w3] Era ${era}: block_roots Merkle root verified against historical_summaries ✓`)
  return roots
}
