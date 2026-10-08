// Cross-check of the light-client checkpoint (the beacon block root Helios starts from).
//
// Helios verifies everything after its checkpoint, but the checkpoint itself is taken from a consensus RPC
// (weak subjectivity). This compares that root against every configured consensus RPC and a set of public
// checkpoint-sync servers, at the same slot, and keeps the result so the user can also check the hash by hand
// (shown in the popup and in settings). It does not decide anything for Helios: it reports agreement.
// Each source ends up as: same hash, a different (false) hash, behind (an old hash), or down (no hash).

import { fetchVerifiedBeaconHeader } from './beacon-verifier.js'
import { timestampToSlot } from './beacon-primitives.js'
import type { ChainConfig } from '../../types.js'

import type { CheckpointInfo, CheckpointSourceResult } from './checkpoint-info.js'
export { checkpointInfoKey } from './checkpoint-info.js'
export type { CheckpointInfo } from './checkpoint-info.js'

// The sources a chain's checkpoint is compared against: its consensus RPCs and the checkpoint sync URLs in its
// settings, nothing else (an empty list in settings means there is no independent server to confirm it).
export function checkpointSources(chain: ChainConfig): Array<{ url: string; kind: CheckpointSourceResult['kind'] }> {
  const seen = new Set<string>()
  const list: Array<{ url: string; kind: CheckpointSourceResult['kind'] }> = []
  const add = (url: string, kind: CheckpointSourceResult['kind']) => {
    const k = url.replace(/\/$/, '').toLowerCase()
    if (!seen.has(k)) { seen.add(k); list.push({ url, kind }) }
  }
  chain.consensusRpcs.forEach(u => add(u, 'consensus'))
  ;(chain.checkpointUrls ?? []).forEach(u => add(u, 'checkpoint-sync'))
  return list
}


// `reached`: the server answered at all (any HTTP status) — tells "down" apart from "no answer for this request".
async function getJson(url: string): Promise<{ ok: boolean; reached: boolean; body?: any }> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, reached: true }
    return { ok: true, reached: true, body: await res.json().catch(() => undefined) }
  } catch { return { ok: false, reached: false } }
}

type Lookup =
  | { status: 'ok'; root: string }
  | { status: 'behind'; root?: string; epoch?: number }
  | { status: 'down'; detail: string }

// What a source says about `slot`. Checkpoint-sync servers (checkpointz) expose their own list of recent
// finalized epochs; full beacon APIs answer the standard lookups. A source whose own finalized checkpoint is older
// than ours is "behind" (an old hash, not a false one); one that can't be reached or can't answer is "down".
async function lookupSource(base: string, slot: number): Promise<Lookup> {
  const b = base.replace(/\/$/, '')
  let reached = false

  const cz = await getJson(`${b}/checkpointz/v1/beacon/slots`)
  reached ||= cz.reached
  const list = cz.body?.data?.slots
  if (cz.ok && Array.isArray(list)) {
    const hit = list.find((s: any) => Number(s?.slot) === slot && typeof s?.block_root === 'string')
    if (hit) return { status: 'ok', root: hit.block_root }
    const known = list.filter((s: any) => Number.isFinite(Number(s?.slot)) && typeof s?.block_root === 'string')
    const newest = known.sort((x: any, y: any) => Number(y.slot) - Number(x.slot))[0]
    if (newest && Number(newest.slot) < slot) return { status: 'behind', root: newest.block_root, epoch: Math.floor(Number(newest.slot) / 32) }
    return { status: 'down', detail: 'no answer for this slot' }
  }

  // Standard beacon API: the header lookup, or the block-root lookup (some nodes only serve one of them).
  for (const path of [`/eth/v1/beacon/headers/${slot}`, `/eth/v1/beacon/blocks/${slot}/root`]) {
    const h = await getJson(b + path)
    reached ||= h.reached
    const root = h.body?.data?.root
    if (h.ok && typeof root === 'string') return { status: 'ok', root }
  }
  // No answer for the slot: is the node simply behind?
  const fc = await getJson(`${b}/eth/v1/beacon/states/head/finality_checkpoints`)
  reached ||= fc.reached
  const fin = fc.body?.data?.finalized
  if (fc.ok && fin && Number(fin.epoch) * 32 < slot) return { status: 'behind', root: fin.root, epoch: Number(fin.epoch) }
  return { status: 'down', detail: reached ? 'no answer for this slot' : 'unreachable' }
}

export async function checkCheckpoint(chain: ChainConfig, root: string | null, startedAt: number, adoptedAt: number): Promise<CheckpointInfo> {
  const base = { chainId: chain.chainId, root, startedAt, checkedAt: Date.now(), adoptedAt }
  if (!root) return { ...base, slot: null, epoch: null, sources: [], verdict: 'unconfirmed' }

  // The checkpoint's slot. Any consensus RPC can tell us; the header must hash to the root, so it can't lie about it.
  let slot: number | null = null
  for (const rpc of chain.consensusRpcs) {
    try {
      const h = await fetchVerifiedBeaconHeader(rpc.replace(/\/$/, ''), root)
      if (h.root.toLowerCase() === root.toLowerCase()) { slot = Number(h.msg.slot); break }
    } catch { /* next */ }
  }
  if (slot === null) return { ...base, slot: null, epoch: null, sources: [], verdict: 'unconfirmed' }

  const list = checkpointSources(chain)

  const sources = await Promise.all(list.map(async ({ url, kind }): Promise<CheckpointSourceResult> => {
    const r = await lookupSource(url, slot!)
    if (r.status === 'down') return { url, kind, status: 'down', detail: r.detail }
    if (r.status === 'behind') return { url, kind, status: 'behind', root: r.root, epoch: r.epoch }
    return r.root.toLowerCase() === root.toLowerCase()
      ? { url, kind, status: 'match' }
      : { url, kind, status: 'mismatch', root: r.root }
  }))

  // A real finalized checkpoint is minutes old. One far in the past (or in the future) cannot be the chain's current
  // finalized block, whatever any single source says — e.g. a root from another network, or an old fork.
  let problem: string | undefined
  try {
    const ageSec = (timestampToSlot(Math.floor(Date.now() / 1000), chain.chainId) - slot) * 12
    if (ageSec < -60) problem = 'Checkpoint lies in the future for this network'
    else if (ageSec > 14 * 86_400) problem = `Checkpoint is ${Math.round(ageSec / 86_400)} days old — not a current finalized block of this network`
  } catch { /* unknown genesis: no age check */ }

  const matches = sources.filter(s => s.status === 'match').length
  const verdict = problem || sources.some(s => s.status === 'mismatch') ? 'disagree' : matches >= 2 ? 'agree' : 'unconfirmed'
  return { ...base, slot, epoch: Math.floor(slot / 32), sources, verdict, ...(problem ? { problem } : {}) }
}
