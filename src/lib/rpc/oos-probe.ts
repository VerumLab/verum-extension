// Waits for a freshly started Helios instance to catch its execution head up, and tells a slow start apart
// from a wedged instance.
//
// A new instance is typically minutes behind the chain (it re-anchors from the last finalized checkpoint) and
// reports "out of sync: N seconds behind" until its first updates arrive, usually within ~30s. Judging by the
// first reading alone — "N >= 150 means wedged" — restarted every fresh Sepolia instance (it starts ~300s
// behind) before it could recover, forever, and each restart also destroyed the instance verification was using.
// So: only call it wedged after a grace period, and only if the lag is still large and not improving.

export type ProbeResult =
  | { kind: 'ready'; waitedMs: number }
  | { kind: 'other-error' }                       // not an out-of-sync error: let the caller proceed
  | { kind: 'wedged'; lag: number }
  | { kind: 'exhausted'; lag: string }

export interface ProbeOptions {
  wedgeLag: number          // seconds behind at/above which an instance that is not recovering counts as wedged
  graceMs: number           // never call it wedged before this much waiting
  budgetMs: number          // give up (exhausted) after this long
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWaiting?: (elapsedS: number, lag: string) => void
}

export async function waitForExecutionHead(request: () => Promise<unknown>, o: ProbeOptions): Promise<ProbeResult> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const pollMs = o.pollMs ?? 500
  const t0 = now()
  let lastLag = '?'
  let firstLag: number | undefined
  let lastReport = 0
  while (now() - t0 < o.budgetMs) {
    try {
      await request()
      return { kind: 'ready', waitedMs: now() - t0 }
    } catch (err) {
      const msg = (err as Error)?.message ?? ''
      if (!msg.includes('out of sync')) return { kind: 'other-error' }
      lastLag = msg.match(/(\d+) seconds? behind/)?.[1] ?? '?'
      const lag = Number(lastLag)
      if (Number.isFinite(lag)) {
        if (firstLag === undefined) firstLag = lag
        // Still far behind after the grace period, and no better than when we started: it is not catching up.
        if (now() - t0 >= o.graceMs && lag >= o.wedgeLag && lag >= firstLag) return { kind: 'wedged', lag }
      }
    }
    const elapsed = now() - t0
    if (o.onWaiting && elapsed - lastReport >= 5000) { lastReport = elapsed; o.onWaiting(Math.round(elapsed / 1000), lastLag) }
    await sleep(pollMs)
  }
  return { kind: 'exhausted', lag: lastLag }
}
