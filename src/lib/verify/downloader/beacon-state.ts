import { w3log } from '../../log'
// Downloads the finalized BeaconState from a consensus RPC or checkpoint sync
// provider, verifies its SSZ hash_tree_root, and extracts
// historical_summaries[hsIndex].block_summary_root — plus block_roots[slot % 8192]
// directly for any target slot within the state's rolling 8192-slot window.

import { computeBeaconStateRoot, isGloasSlot } from '../ssz-state-verifier.js'
import { readU32LE } from '../beacon-primitives.js'
import type { StateSource } from '../../../types.js'

// Checkpoint sync providers serve gzip-compressed BeaconState via the same debug endpoint.
// Mainnet: ~136 MB compressed (vs ~313 MB uncompressed).
// These always serve the latest finalized state, request 'finalized' instead of slot.
const CHECKPOINT_SYNC_RPCS: Record<number, string[]> = {
  1: [
    'https://mainnet.checkpoint.sigp.io',
    'https://beaconstate.ethstaker.cc',
    'https://beaconstate-mainnet.chainsafe.io',
  ],
  11155111: [
    'https://checkpoint-sync.sepolia.ethpandaops.io',
    'https://beaconstate-sepolia.chainsafe.io',
  ],
}

export interface StateSummary {
  blockSummaryRoot: string
  effectiveStateRoot: string
  effectiveSlot: number
  blockRootsAtSlots: Record<number, string>  // slot → block_roots[slot % 8192] for slots within the rolling window
  getHistoricalSummariesBlob: () => string
  computeHistoricalSummariesFieldProof: () => string
}

export async function getBlockSummaryRoot(
  consensusRpcs: string[],
  anchorSlot: number,
  anchorStateRoot: string,
  hsIndex: number,
  era: number,
  chainId: number,
  targetSlots: number[],
  customCheckpointUrls?: string[],
  stateSource: StateSource = 'auto',
): Promise<StateSummary> {
  // open(): resolve the download slot and fetch the response HEADERS (fast, race-able).
  // consume(): download the ~300MB SSZ body and verify (runs for the winner only).
  const open = async (rpc: string, ac: AbortController): Promise<OpenState> => {
    if (ac.signal.aborted) throw new Error('open aborted before start')
    const stateId = await fetchLiveDlSlot(rpc, ac.signal)
    w3log(`[w3] Fetching state (slot ${stateId}) from ${rpc}…`)
    const res = await fetch(`${rpc}/eth/v2/debug/beacon/states/${stateId}`, {
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'gzip' },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`${rpc}: HTTP ${res.status}`)
    return { rpc, res }
  }

  const consume = async ({ rpc, res }: OpenState): Promise<StateSummary> => {
    // Stream with stall detection. 
    const stateSSZ = await downloadWithStallTimeout(res, 20_000)
    // slot is at byte 40 of BeaconState SSZ (genesis_time[8] + genesis_validators_root[32])
    const stateSlot = readU32LE(stateSSZ, 40)
    const verifier = computeBeaconStateRoot(stateSSZ, isGloasSlot(chainId, stateSlot) ? 'gloas' : undefined)
    if (verifier.computedRoot.toLowerCase() !== anchorStateRoot.toLowerCase()) {
      w3log(`[w3] State slot=${stateSlot} anchorSlot=${anchorSlot} diff=${stateSlot - anchorSlot} — Helios will confirm at end`)
    } else {
      w3log(`[w3] State hash_tree_root matches anchor ✓ (slot ${stateSlot}, from ${rpc})`)
    }

    // Fast path: for every target slot within the rolling block_roots window of this
    // state, read block_roots[slot % 8192] directly (authenticated by hash_tree_root(BeaconState)).
    const blockRootsAtSlots: Record<number, string> = {}
    for (const targetSlot of targetSlots) {
      if (stateSlot >= targetSlot && stateSlot - targetSlot < 8192) {
        const root = verifier.getBlockRootAtSlot(targetSlot)
        if (!/^0x0+$/.test(root)) {
          blockRootsAtSlots[targetSlot] = root
          w3log(`[w3] block_roots[${targetSlot % 8192}] from BeaconState: ${root}`)
        }
      }
    }

    const blockSummaryRoot = verifier.getBlockSummaryRoot(hsIndex)
    if (!blockSummaryRoot && Object.keys(blockRootsAtSlots).length === 0)
      throw new Error(`historical_summaries[${hsIndex}] (era ${era}) not found and no slot in rolling window`)
    if (blockSummaryRoot)
      w3log(`[w3] historical_summaries[${hsIndex}] (era ${era}) block_summary_root: ${blockSummaryRoot}`)
    return { blockSummaryRoot: blockSummaryRoot ?? '', effectiveStateRoot: verifier.computedRoot, effectiveSlot: stateSlot, blockRootsAtSlots, getHistoricalSummariesBlob: () => verifier.getHistoricalSummariesBlob(), computeHistoricalSummariesFieldProof: () => verifier.computeHistoricalSummariesFieldProof() }
  }

  // Use configured URLs when provided; fall back to built-in defaults only when undefined.
  const checkpointRpcs = customCheckpointUrls !== undefined
    ? customCheckpointUrls
    : (CHECKPOINT_SYNC_RPCS[chainId] ?? [])

  // Race checkpoint providers and consensus RPCs.
  // Stagger 3s between each start: a fast failure triggers the next immediately.
  // Consensus RPC nodes serve any recent slot so anchorSlot-32 is fine.
  const dlSlot = anchorSlot - 32

  const fetchLiveDlSlot = async (rpc: string, signal: AbortSignal): Promise<number> => {
    try {
      const hRes = await fetch(`${rpc}/eth/v1/beacon/headers/finalized`, {
        headers: { Accept: 'application/json' },
        signal,
      })
      if (hRes.ok) {
        const hJson = await hRes.json() as { data: { header: { message: { slot: string } } } }
        const finSlot = parseInt(hJson.data.header.message.slot, 10)
        if (finSlot > 0) return finSlot - 32
      }
    } catch { /* fall back */ }
    return dlSlot
  }

  // Dev mode pins one side of the race.
  const useCheckpoints = stateSource !== 'consensus-rpc'
  const useConsensus   = stateSource !== 'checkpoint'
  if (stateSource !== 'auto') {
    w3log(`[w3] BeaconState: dev mode — forcing ${stateSource === 'checkpoint'
      ? 'checkpoint providers' : 'consensus RPCs'} only`)
  }

  // Interleave checkpoint providers and consensus RPCs so both types get an early slot.
  const ordered: string[] = []
  const cp = useCheckpoints ? checkpointRpcs : []
  const cn = useConsensus ? consensusRpcs : []
  for (let i = 0; i < Math.max(cp.length, cn.length); i++) {
    if (cp[i]) ordered.push(cp[i])
    if (cn[i]) ordered.push(cn[i])
  }
  if (ordered.length === 0) {
    throw new Error(stateSource === 'auto'
      ? 'No consensus RPC or checkpoint provider configured'
      : `Dev mode: no ${stateSource === 'checkpoint' ? 'checkpoint provider' : 'consensus RPC'} configured for this chain`)
  }

  // Race the OPENS (headers) with a 3s stagger so a dead provider (501/503, fast) yields
  // quickly; the first to return 200 wins and downloads the body alone. If the winner's
  // body download later fails, drop it and race the remaining providers.
  let remaining = ordered
  let lastErr: Error = new Error('no state provider available')
  while (remaining.length > 0) {
    const controllers = remaining.map(() => new AbortController())
    const opens = remaining.map((rpc, i) => (): Promise<OpenState> => open(rpc, controllers[i]))

    let winner: OpenState
    try {
      winner = await staggeredRace(opens, 3000)
    } catch (e) {
      lastErr = (e as AggregateError).errors?.[0] ?? (e as Error)
      break  // every open failed
    }

    // Commit to the winner: abort the losing opens so only one ~300MB body streams.
    remaining.forEach((rpc, i) => { if (rpc !== winner.rpc) controllers[i].abort() })

    try {
      return await consume(winner)
    } catch (e) {
      lastErr = e as Error
      console.warn(`[w3] State download from ${winner.rpc} failed (${lastErr.message}) — trying next provider`)
      remaining = remaining.filter(r => r !== winner.rpc)
    }
  }

  console.warn('[w3] State fetch failed:', lastErr.message)
  throw new Error(stateSource === 'auto'
    ? 'Could not fetch and verify finalized state from any consensus RPC or checkpoint provider'
    : `Dev mode: could not fetch and verify finalized state from any ${
        stateSource === 'checkpoint' ? 'checkpoint provider' : 'consensus RPC'} (source pinned)`)
}

interface OpenState { rpc: string; res: Response }

// Read a response body to completion, aborting if no chunk arrives for `stallMs`.
async function downloadWithStallTimeout(res: Response, stallMs: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let timer: ReturnType<typeof setTimeout>
    const stall = new Promise<'stall'>(resolve => { timer = setTimeout(() => resolve('stall'), stallMs) })
    let r: ReadableStreamReadResult<Uint8Array> | 'stall'
    try {
      r = await Promise.race([reader.read(), stall])
    } finally {
      clearTimeout(timer!)
    }
    if (r === 'stall') {
      await reader.cancel().catch(() => {})
      throw new Error(`download stalled (no data for ${stallMs / 1000}s)`)
    }
    if (r.done) break
    chunks.push(r.value)
    total += r.value.length
  }
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

// Run async thunks with a stagger between starts; resolve with the first success.
function staggeredRace<T>(thunks: Array<() => Promise<T>>, gapMs: number): Promise<T> {
  return Promise.any(thunks.map((fn, i) =>
    i === 0
      ? fn()
      : new Promise<T>((resolve, reject) => { setTimeout(() => fn().then(resolve, reject), i * gapMs) }),
  ))
}

// Early-abort fetch of a BeaconState's fixed section (first `needBytes`) at an exact slot.
// Streams the gzip'd state from a checkpoint provider and aborts once needBytes are
// decompressed.
export async function fetchFixedSectionAtSlot(
  chainId: number,
  customCheckpointUrls: string[] | undefined,
  stateSlot: number,
  needBytes = 2_740_000,
): Promise<{ fixedSection: Uint8Array; slot: number } | null> {
  const rpcs = customCheckpointUrls !== undefined ? customCheckpointUrls : (CHECKPOINT_SYNC_RPCS[chainId] ?? [])
  const stateId = String(stateSlot)
  for (const rpc of rpcs) {
    const ac = new AbortController()
    try {
      const res = await fetch(`${rpc}/eth/v2/debug/beacon/states/${stateId}`, {
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'gzip' },
        signal: ac.signal,
      })
      if (!res.ok || !res.body) { ac.abort(); continue }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < needBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value); total += value.length
      }
      ac.abort()  // stop the underlying download
      if (total < needBytes) continue
      const out = new Uint8Array(total); let p = 0
      for (const c of chunks) { out.set(c, p); p += c.length }
      const slot = readU32LE(out, 40)  // BeaconState.slot @ byte 40
      w3log(`[w3] anchor fixed section: ${(total / 1e6).toFixed(2)}MB early-abort from ${rpc} (slot ${slot})`)
      return { fixedSection: out.subarray(0, needBytes), slot }
    } catch { try { ac.abort() } catch {}; continue }
  }
  return null
}
