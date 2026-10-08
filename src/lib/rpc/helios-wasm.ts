import { w3log } from '../log'
import { createHeliosProvider } from '@a16z/helios'
import type { HeliosProvider, Network } from '@a16z/helios'
import type { IVerifiedRpc } from './light-client.js'
import { pinnedCheckpointKey, CHECKPOINT_REUSE_MS, type PinnedCheckpoint } from '../verify/checkpoint-info.js'

// EIP-4788 ring buffer — used as a probe to verify eth_getProof works on the exec RPC.
const EIP4788_PROBE = '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02'

export class HeliosWasmClient implements IVerifiedRpc {
  // Number of provider.request() calls currently awaiting the WASM, and a barrier that
  // shutdown() waits on.
  // This lets an OOS-wedge restart evict-and-replace the instance without crashing an
  // in-flight verification call on it.
  static alive = 0   // Helios WASM instances created and not yet shut down
  private inFlight = 0
  private idleWaiters: Array<() => void> = []
  private shuttingDown = false
  private constructor(
    private readonly provider: HeliosProvider,
    // The checkpoint (beacon block root) THIS instance was started from. Helios only accepts a bootstrap whose
    // header hashes to it, so it is the instance's trust anchor; it is what Verum shows and cross-checks.
    readonly checkpoint: string,
  ) {}

  checkpointRoot(): string { return this.checkpoint }

  // Races up to 2 execution RPCs with an EIP-4788 proof probe; first to pass wins.
  // Falls back to the first exec RPC unprobed if all probes fail.
  static async create(
    network: Network,
    consensusRpc: string,
    executionRpcs: string[],
    forceFresh = false,
  ): Promise<HeliosWasmClient> {
    // Helios starts from the checkpoint the user checked or chose (pinned for a day, CHECKPOINT_REUSE_MS, surviving
    // restarts) so they don't have to compare a new hash on every start. Without such a pin — or when no provider
    // still serves its bootstrap — it starts from the current finalized root, which the sources (or the user) must
    // confirm before anything is verified. A restart after a wedge (forceFresh) keeps the pin too: the stalls come
    // from stale finality updates, not from the checkpoint. Never starts without a checkpoint (Helios would fall back
    // to its own built-in one, months old and not the hash Verum shows).
    void forceFresh
    const pinKey = pinnedCheckpointKey(network)
    const pin = (await chrome.storage.local.get(pinKey).catch(() => ({})) as Record<string, unknown>)[pinKey] as PinnedCheckpoint | undefined
    const cachedCheckpoint = pin?.userChosen && Date.now() - pin.adoptedAt < CHECKPOINT_REUSE_MS ? pin.root : undefined

    // The root each start uses is returned with its provider, so the instance always reports the root it really
    // started from (also after falling back from the pin to a fresh root).
    const sync = async (execRpc: string): Promise<{ provider: HeliosProvider; root: string }> => {
      if (cachedCheckpoint) {
        try {
          return { provider: await HeliosWasmClient.trySync(network, consensusRpc, execRpc, cachedCheckpoint, 'pinned checkpoint'), root: cachedCheckpoint }
        } catch (err) {
          // Providers keep light-client bootstrap data only for recent checkpoints (on Sepolia: only the latest one).
          w3log('[w3] Helios pinned checkpoint unavailable — starting from a fresh finalized root (to be confirmed again):', (err as Error).message)
          // Drop the dead pin (unless the user pinned another root meanwhile), so later starts don't retry it.
          const now = (await chrome.storage.local.get(pinKey).catch(() => ({})) as Record<string, unknown>)[pinKey] as PinnedCheckpoint | undefined
          if (now?.root === cachedCheckpoint) await chrome.storage.local.remove(pinKey).catch(() => {})
        }
      }
      // A provider may serve the bootstrap only for the LATEST finalized root, so finality moving on between fetching
      // the root and the bootstrap fails the start: fetch the root again and retry once.
      for (let attempt = 0; ; attempt++) {
        const fresh = await HeliosWasmClient.fetchFinalizedRoot(consensusRpc)
        if (!fresh) throw new Error('Helios not started: no checkpoint — the consensus RPC returned no finalized root')
        try {
          return { provider: await HeliosWasmClient.trySync(network, consensusRpc, execRpc, fresh, 'live finalized root'), root: fresh }
        } catch (err) {
          if (attempt >= 1) throw err
          w3log('[w3] Helios start from the finalized root failed — fetching the current one and retrying once:', (err as Error).message)
        }
      }
    }

    const syncAndProbe = async (execRpc: string): Promise<{ provider: HeliosProvider; root: string }> => {
      const host = execRpc.includes('.invalid') ? 'proxy' : new URL(execRpc).hostname
      const started = await sync(execRpc)
      const provider = started.provider
      w3log(`[w3] Helios (exec=${host}) probing EIP-4788…`)
      try {
        const block = await provider.request({
          method: 'eth_getBlockByNumber', params: ['finalized', false],
        }) as { timestamp?: string; number?: string } | null
        if (block?.timestamp) {
          const ts = parseInt(block.timestamp, 16)
          await provider.request({
            method: 'eth_call',
            params: [{ to: EIP4788_PROBE, data: '0x' + ts.toString(16).padStart(64, '0') }, 'finalized'],
          })
        }
      } catch (err) {
        console.warn(`[w3] Helios exec probe (${host}): failed —`, (err as Error).message)
        await provider.shutdown().catch(() => {})
        throw err
      }
      return started
    }

    const candidates = executionRpcs.slice(0, 2)
    let started: { provider: HeliosProvider; root: string }

    if (candidates.length === 1) {
      started = await sync(candidates[0])
    } else {
      const attempts = candidates.map(rpc => syncAndProbe(rpc))
      started = await Promise.any(attempts).catch(async () => {
        console.warn('[w3] All exec RPC probes failed — using first RPC unprobed')
        return sync(candidates[0])
      })
      // Shut down any extra provider that synced but lost the race.
      for (const p of attempts) {
        p.then(w => { if (w.provider !== started.provider) w.provider.shutdown().catch(() => {}) }).catch(() => {})
      }
    }

    return new HeliosWasmClient(started.provider, started.root)
  }

  // Slots per epoch — light-client bootstrap data is indexed per epoch boundary.
  private static readonly SLOTS_PER_EPOCH = 32

  // Returns a finalized checkpoint root that light_client/bootstrap will serve.
  // When the finalized root isn't on a boundary, walk back over earlier
  // boundary slots until one has a block. 
  static async fetchFinalizedRoot(consensusRpc: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${consensusRpc}/eth/v1/beacon/headers/finalized`)
      if (!res.ok) return undefined
      const json = await res.json() as {
        data?: { root?: string; header?: { message?: { slot?: string } } }
      }
      const root = json.data?.root
      const slot = Number(json.data?.header?.message?.slot)
      if (!root) return undefined
      if (!Number.isFinite(slot) || slot % HeliosWasmClient.SLOTS_PER_EPOCH === 0) return root

      // Boundary slot was skipped — find the most recent boundary that has a block.
      let boundary = slot - (slot % HeliosWasmClient.SLOTS_PER_EPOCH)
      for (let i = 0; i < 8 && boundary > 0; i++, boundary -= HeliosWasmClient.SLOTS_PER_EPOCH) {
        const r = await fetch(`${consensusRpc}/eth/v1/beacon/headers/${boundary}`)
        if (!r.ok) continue  // no block at this boundary either — step back an epoch
        const j = await r.json() as { data?: { root?: string } }
        if (j.data?.root) {
          w3log(`[w3] Helios: finalized checkpoint at slot ${slot} is off-boundary ` +
            `(skipped proposal) — bootstrapping from boundary slot ${boundary} instead`)
          return j.data.root
        }
      }
      return root  // give up; trySync's fallbacks still get a chance
    } catch {
      return undefined
    }
  }

  private static async trySync(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
    checkpoint: string,
    checkpointLabel: string,
  ): Promise<HeliosProvider> {
    const execHost = executionRpc.includes('.invalid') ? 'proxy' : new URL(executionRpc).hostname
    const tag = `[w3] Helios (exec=${execHost})`
    w3log(`${tag} creating provider (${checkpointLabel})`)
    // dbType is how Helios persists its own checkpoint between runs. Only
    // "localstorage" and "config" exist. localStorage does not exist in a service
    // worker.
    //
    // Fix: Verum keeps the checkpoint itself (pinned for a day in chrome.storage.local, see create())
    // and hands it in via `checkpoint` on every start. Helios then reads the checkpoint from config
    // and stops pretending it has a DB.
    const provider = await createHeliosProvider(
      { network, consensusRpc, executionRpc, dbType: 'config', checkpoint },
      'ethereum',
    )
    // Diagnostic for the extension-process crashes: every WASM instance not shut down keeps its memory, so a count
    // that keeps growing across restarts is a leak.
    HeliosWasmClient.alive++
    w3log(`${tag} Helios instances alive: ${HeliosWasmClient.alive}`)
    const shutdownOnce = provider.shutdown.bind(provider)
    let down = false
    provider.shutdown = async () => {
      if (!down) { down = true; HeliosWasmClient.alive--; w3log(`${tag} shut down — Helios instances alive: ${HeliosWasmClient.alive}`) }
      return shutdownOnce()
    }
    const t1 = Date.now()
    const ticker = setInterval(
      () => w3log(`${tag} still syncing… (${Math.round((Date.now() - t1) / 1000)}s)`),
      5_000,
    )
    try {
      await Promise.race([
        provider.waitSynced(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Helios waitSynced timeout')), 30_000),
        ),
      ])
    } catch (err) {
      // A start that did not sync keeps its WASM instance and polling loops alive unless shut down.
      await provider.shutdown().catch(() => {})
      throw err
    } finally {
      clearInterval(ticker)
    }
    return provider
  }

  async request<T>(method: string, params: unknown[], quickFail = false): Promise<T> {
    this.inFlight++
    try {
      return await this._request<T>(method, params, quickFail)
    } finally {
      if (--this.inFlight === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  private async _request<T>(method: string, params: unknown[], quickFail = false): Promise<T> {
    // Guard against WASM hangs: if provider.request() never resolves (WASM panic,
    // OOM, etc.) the acquireEthCallSlot slot held by the caller is never released.
    const startedAt = Date.now()
    const call = (): Promise<T> =>
      Promise.race([
        this.provider.request({ method, params: params as unknown[] }) as Promise<T>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Helios WASM call timeout')), 45_000),
        ),
      ])
    try {
      const result = await call()
      return result
    } catch (err: any) {
      if ((err?.message ?? '').includes('out of sync')) {
        if (quickFail) throw err
        const lag = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
        console.warn(`[w3] Helios ${method} OOS (${lag}s behind) — retrying in 3s`)
        await new Promise(r => setTimeout(r, 3_000))
        const result = await call()
          return result
      }
      console.warn(`[w3] Helios ${method} FAILED after ${Date.now() - startedAt}ms — ${err?.message ?? err}`)
      throw err
    }
  }

  isHeliosBacked(): boolean { return true }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    // Wait for in-flight requests to settle before tearing down the WASM. 
    // Bounded so a genuinely hung call can't block eviction forever.
    if (this.inFlight > 0) {
      await Promise.race([
        new Promise<void>(resolve => this.idleWaiters.push(resolve)),
        new Promise<void>(resolve => setTimeout(resolve, 46_000)),
      ])
    }
    await this.provider.shutdown().catch(() => {})
  }
}
