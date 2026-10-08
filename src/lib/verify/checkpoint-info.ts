// The stored result of the light-client checkpoint cross-check (see checkpoint-check.ts), and how it is worded in
// the popup and in settings. Kept separate so those pages don't pull in the verifier code.

// match:    same hash at the same slot
// mismatch: a DIFFERENT hash for the same slot (a false hash)
// behind:   reachable, but its finalized checkpoint is older than ours (an old hash; its own epoch/hash are kept)
// down:     no hash — unreachable, or no answer for this slot
export type SourceStatus = 'match' | 'mismatch' | 'behind' | 'down'

export interface CheckpointSourceResult {
  url: string
  kind: 'consensus' | 'checkpoint-sync'
  status: SourceStatus
  root?: string        // mismatch: the hash it reported; behind: its own latest finalized hash
  epoch?: number       // behind: its own latest finalized epoch
  detail?: string      // down: 'unreachable' or 'no answer for this slot'
}

export interface CheckpointInfo {
  chainId: number
  root: string | null  // null: Helios fell back to its own built-in checkpoint
  slot: number | null
  epoch: number | null
  startedAt: number
  checkedAt: number
  adoptedAt: number    // when Verum started using this checkpoint (it is kept for CHECKPOINT_REUSE_MS)
  userCheckedAt?: number  // when the user confirmed they compared the hash with a source they trust
  sources: CheckpointSourceResult[]
  verdict: 'agree' | 'disagree' | 'unconfirmed'
  problem?: string     // set when the checkpoint itself is implausible (e.g. far older than a finalized block can be)
}

// Both live in chrome.storage.local, so a checkpoint (and the user's check of it) survives browser restarts.
export const checkpointInfoKey = (chainId: number) => `checkpoint_info_${chainId}`
export const pinnedCheckpointKey = (network: string) => `helios_pinned_checkpoint_${network}`
// Only a checkpoint the user checked ("I checked it") or chose (disagreement dialog) is pinned; userChosen marks
// those. Any other start takes the current finalized root, which the sources must confirm again.
export interface PinnedCheckpoint { root: string; adoptedAt: number; userChosen?: boolean }

// How long a checkpoint the user checked or chose is kept. Far inside the 14-day weak-subjectivity limit; a light
// client syncs forward from it with signed updates.
export const CHECKPOINT_REUSE_MS = 24 * 3600_000

// Agreement among the sources that returned a hash for the checkpoint's slot (behind/down ones gave none).
export function checkpointAgreement(info: CheckpointInfo): { match: number; answered: number } {
  const match = info.sources.filter(s => s.status === 'match').length
  const answered = match + info.sources.filter(s => s.status === 'mismatch').length
  return { match, answered }
}

// Whether the user still has to confirm the checkpoint themselves. Required when half or fewer of the sources
// that answered agree with it, when no independent checkpoint-sync server confirmed it, or when the checkpoint itself
// is implausible. Not required once the user confirmed (or chose) it.
export function checkpointCheckState(info: CheckpointInfo): 'confirmed' | 'user-checked' | 'needs-check' {
  if (info.userCheckedAt) return 'user-checked'
  const { match, answered } = checkpointAgreement(info)
  const majority = match * 2 > answered   // strictly more than half (exactly half is not enough)
  const syncConfirmed = info.sources.some(s => s.kind === 'checkpoint-sync' && s.status === 'match')
  return !info.problem && majority && syncConfirmed ? 'confirmed' : 'needs-check'
}

// The distinct checkpoints the sources report for the slot, most-reported first, for the user to choose from.
export interface CheckpointCandidate { root: string; reportedBy: string[]; inUse: boolean }

export function checkpointCandidates(info: CheckpointInfo): CheckpointCandidate[] {
  if (!info.root) return []
  const by = new Map<string, string[]>([[info.root.toLowerCase(), []]])
  const label = new Map<string, string>([[info.root.toLowerCase(), info.root]])
  for (const s of info.sources) {
    const r = s.status === 'match' ? info.root : s.status === 'mismatch' ? s.root : undefined
    if (!r) continue
    const k = r.toLowerCase()
    if (!by.has(k)) { by.set(k, []); label.set(k, r) }
    by.get(k)!.push(host(s.url))
  }
  return [...by.entries()]
    .map(([k, hosts]) => ({ root: label.get(k)!, reportedBy: hosts, inUse: k === info.root!.toLowerCase() }))
    .sort((a, b) => b.reportedBy.length - a.reportedBy.length || Number(b.inUse) - Number(a.inUse))
}

// Records that the user compared this exact hash with a source they trust (kept until a new checkpoint is adopted).
export async function markCheckpointChecked(chainId: number, root: string): Promise<void> {
  const key = checkpointInfoKey(chainId)
  const info = (await chrome.storage.local.get(key))[key] as CheckpointInfo | undefined
  if (!info || info.root !== root) return
  await chrome.storage.local.set({ [key]: { ...info, userCheckedAt: Date.now() } })
}

// How long a checkpoint the user checked stays in use before a new one is adopted (and checked again), as h:mm:ss.
// One the sources confirmed is not kept (the next Helios start takes a fresh one), so it has no countdown: ''.
export function checkpointRecheckText(info: CheckpointInfo): string {
  if (!info.userCheckedAt) return ''
  const ms = info.userCheckedAt + CHECKPOINT_REUSE_MS - Date.now()
  if (ms <= 0) return 'Expired — renews on the next start'
  const s = Math.floor(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Valid for ${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

export const CHECK_HINT = 'Compare it with a source you trust: your own beacon node, a block explorer, or a checkpoint ' +
  'sync server. The hash only changes once a day.'

const host = (url: string) => { try { return new URL(url).hostname } catch { return url } }
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h)

export function checkpointSummary(info: CheckpointInfo | undefined): string {
  if (!info) return 'Light client not started yet in this browser session'
  if (!info.root) return 'Helios built-in checkpoint (no fresh root was available)'
  if (info.slot === null) return 'Could not look up this checkpoint'
  if (info.problem) return `⚠ ${info.problem}`
  const count = (s: SourceStatus) => info.sources.filter(x => x.status === s).length
  const ok = count('match'), bad = count('mismatch'), behind = count('behind'), down = count('down')
  const extra = [behind ? `${behind} behind` : '', down ? `${down} down` : ''].filter(Boolean).join(', ')
  const tail = `epoch ${info.epoch}${extra ? ` · ${extra}` : ''}`
  if (bad) return `⚠ ${bad} source${bad === 1 ? ' reports' : 's report'} a different hash · ${ok} agree · ${tail}`
  if (info.verdict === 'agree') return `✓ ${ok} of ${info.sources.length} sources agree · ${tail}`
  return `${ok} of ${info.sources.length} sources confirmed · ${tail}`
}

// One row per source: who (left) and what it said (right).
export interface CheckpointSourceRow { left: string; right: string; status: SourceStatus }

export function checkpointSourceRows(info: CheckpointInfo | undefined): CheckpointSourceRow[] {
  if (!info) return []
  return info.sources.map((s) => {
    const who = `${host(s.url)} (${s.kind === 'consensus' ? 'consensus RPC' : 'checkpoint sync'})`
    switch (s.status) {
      case 'match': return { status: s.status, left: `✓ ${who}`, right: 'same hash' }
      case 'mismatch': return { status: s.status, left: `✗ ${who}`, right: `DIFFERENT hash ${short(s.root ?? '?')}` }
      case 'behind': return { status: s.status, left: `… ${who}`, right: `behind: epoch ${s.epoch ?? '?'}${s.root ? ` (${short(s.root)})` : ''}` }
      default: return { status: s.status, left: `– ${who}`, right: `down: ${s.detail ?? 'no answer'}` }
    }
  })
}

export function checkpointSourceLines(info: CheckpointInfo | undefined): string[] {
  return checkpointSourceRows(info).map(r => `${r.left} — ${r.right}`)
}
