import { parseWeb3URL } from './lib/w3/url-parser.js'
import { RpcClient, createVerifiedRpc } from './lib/rpc/light-client.js'
import { getVerifiedCalldataByLocation, verifyTxInBlock } from './lib/verify/tx-verifier.js'
import type { RpcBlockFull } from './lib/verify/tx-verifier.js'
import { getCalldataViaPortal } from './lib/rpc/portal.js'
import { parseCalldata, assembleContent } from './lib/w3/content.js'
import { resolveEns, resolveName, nameIsIpfs, compareEnsChunks } from './lib/w3/name-resolver.js'
import type { TxRef, NameResolution } from './lib/w3/name-resolver.js'
import { fetchContractContent } from './lib/w3/erc5219.js'
import type { ContractContent } from './lib/w3/erc5219.js'
import { verifyViaBeacon, isEip2935Error, SUPERSEDED } from './lib/verify/beacon-verifier.js'
import { timestampToSlot } from './lib/verify/beacon-primitives.js'
import type { DappProofData, EraBsrCache } from './lib/verify/beacon-verifier.js'
import { DEFAULT_CHAINS, DEFAULT_DEV_SETTINGS, AGREEMENT_VERSION } from './types.js'
import type { BgMessage, BgResponse, VerificationUpdate, ChainConfig, VerificationResult, DevSettings, EraSource, StateSource, ForceMode, HistSource } from './types.js'
import { listWallets, ethRequest as walletRequest } from './lib/wallets/extension-wallet-bridge.js'
import { isFrameAvailable, frameRequest } from './lib/wallets/local-wallet-bridge.js'
import type { IVerifiedRpc } from './lib/rpc/light-client.js'

// First install → open the Terms-of-Use onboarding page.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
  }
})

// True once the user has accepted the current Terms of Use on the onboarding page.
async function agreementAccepted(): Promise<boolean> {
  const { agreement } = await chrome.storage.local.get('agreement') as { agreement?: { accepted?: boolean; version?: number } }
  return !!agreement?.accepted && (agreement.version ?? 0) >= AGREEMENT_VERSION
}

// Lag (seconds behind) at which an OOS instance is considered unrecoverable and
// the WASM is torn down and re-synced, rather than re-probed in place.
const OOS_RESTART_LAG_SECONDS = 150

const rpcCache = new Map<number, Promise<IVerifiedRpc>>()

// Removes a chain's WASM instance from the cache AND shuts it down. Deleting
// the cache entry alone leaks the instance: its internal polling loops keep
// running with no JS reference.
function evictChainRpc(chainId: number) {
  const old = rpcCache.get(chainId)
  rpcCache.delete(chainId)
  old?.then(rpc => (rpc as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => {})).catch(() => {})
}

// Diagnostic-only: a genuinely stale feed and a healthy feed with a wedged
// WASM instance produce the SAME symptom from the instance's side. This records
// which one it actually is so the log stops mislabeling a healthy feed as stale.
// Never throws; hits the real consensus URLs, not the proxy sentinels.
async function logConsensusLiveness(chain: ChainConfig, emsg: string, n: number): Promise<void> {
  const expectedSlot = timestampToSlot(Math.floor(Date.now() / 1000), chain.chainId)
  for (const rpc of chain.consensusRpcs) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      const res = await fetch(rpc.replace(/\/$/, '') + '/eth/v1/beacon/light_client/optimistic_update',
        { headers: { Accept: 'application/json' }, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      const body = await res.json() as { data?: { attested_header?: { beacon?: { slot?: string } } } }
      const slot = Number(body?.data?.attested_header?.beacon?.slot)
      if (!Number.isFinite(slot)) continue
      const behind = (expectedSlot - slot) * 12
      const host = new URL(rpc).hostname
      if (behind > OOS_RESTART_LAG_SECONDS) {
        console.warn(`[w3] ${emsg} — ${n} consecutive wedged restarts; consensus feed IS stale ` +
          `(${host} optimistic head ${behind}s behind wall-clock), backing off 15s`)
      } else {
        console.warn(`[w3] ${emsg} — ${n} consecutive wedged restarts, but consensus is current ` +
          `(${host} optimistic head ${behind}s behind) — WASM wedged against a healthy feed; ` +
          `re-anchoring fresh, backing off 15s`)
      }
      return
    } catch { /* endpoint unreachable — try the next */ }
  }
  console.warn(`[w3] ${emsg} — ${n} consecutive wedged restarts; consensus endpoints unreachable ` +
    `for a liveness probe, backing off 15s`)
}
// Chains whose next createVerifiedRpc must re-anchor from a freshly-fetched
// finalized root rather than the cached checkpoint. Set by the wedged-restart
// path: evictChainRpc tears down the WASM but does NOT clear the cached
// checkpoint, so without this the replacement rebuilds the same anchor and
// re-wedges. Consumed (and cleared) in getOrCreateRpc.
const forceFreshAnchor = new Set<number>()
const freshRpcCache = new Map<number, Promise<IVerifiedRpc>>()
// Stores the already-resolved Helios instance once freshRpcCache settles.
// ethRpcCall can check this synchronously and skip the 100ms race entirely.
const freshRpcReady = new Map<number, IVerifiedRpc>()
// Tracks chains for which we've already sent a helios-syncing signal so we
// don't broadcast it on every read call while Helios is warming up.
const heliosSyncingSignaled = new Set<number>()
// Counts consecutive OOS probe exhaustions per chain. After 2 the WASM
// instance is considered stuck and rpcCache is cleared to force a full restart.
const oosExhaustionCount = new Map<number, number>()

// Reads that arrived while Helios wasn't ready. Flushed as a batch once
// freshRpcReady is set. The probe restarts on OOS exhaustion so reads wait
// across multiple probe cycles until Helios recovers — no timeout.
type PendingRead = (rpc: IVerifiedRpc) => void
const pendingReads = new Map<number, PendingRead[]>()

// In-flight dedup: identical reads (same chainId:method:params) share one promise.
// Covers both queued reads (Helios not ready) and live reads (Helios ready).
// Checked synchronously before any async work so there is no race window.
const heliosInflight = new Map<string, Promise<{ result?: unknown; error?: string }>>()

// Stale-while-revalidate cache for small primitive reads only.
// eth_call and similar can return megabytes oded of ABI-encdata — caching those
// inflates the SW heap unboundedly under a polling dapp and triggers OOM.
// Only cache methods whose results are always small (< ~100 bytes).
const CACHEABLE_METHODS = new Set([
  'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
])
const heliosReadCache = new Map<string, unknown>()
const MAX_READ_CACHE = 200

// Trusted-reads toggle: when on, dapp RUNTIME reads (eth_call quotes, balances, …) are
// served from the fast execution RPC WITHOUT Helios verification, so a read-heavy dapp
// responds at normal-RPC speed instead of waiting on per-slot eth_getProof. 
let trustedReads = true
chrome.storage.session.get('trustedReads').then(v => { trustedReads = v.trustedReads !== false }).catch(() => {})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'trustedReads' in changes) trustedReads = changes.trustedReads.newValue !== false
})

// Concurrency limit for non-cacheable Helios reads (eth_call, eth_getLogs, …).
// Each concurrent call holds a large ABI-encoded result in memory while the IPC
// clone travels to the renderer. Cap at 4 concurrent slots so at
// most 4 large results exist in memory at once.
let ethCallSlots = 0
// Read-heavy dapps need more parallel Helios reads.
// 8 balances throughput against the renderer-heap limit.
const ETH_CALL_MAX_SLOTS = 8
const ethCallWaiters: Array<() => void> = []
function acquireEthCallSlot(): Promise<() => void> {
  const release = () => { ethCallSlots--; ethCallWaiters.shift()?.() }
  if (ethCallSlots < ETH_CALL_MAX_SLOTS) { ethCallSlots++; return Promise.resolve(release) }
  return new Promise(resolve => ethCallWaiters.push(() => { ethCallSlots++; resolve(release) }))
}
const tabVerGen = new Map<number, number>()

// Track when the portal last failed so subsequent loads don't spend 15s on a
// TCP-connected-but-silent portal node. Resets when the SW is killed.
let portalLastFailedAt = 0
const PORTAL_FAIL_COOLDOWN = 120_000
function isPortalLikelyDown(): boolean {
  return portalLastFailedAt > 0 && Date.now() - portalLastFailedAt < PORTAL_FAIL_COOLDOWN
}

// ---------------------------------------------------------------------------
// Per-dapp proof cache (chrome.storage.local)
// Key: raw w3:// URL. Value: txHash (for ENS staleness) + 13-hash Merkle proof.
// Skips era file / parquet / exec-header download on re-visit.
// ---------------------------------------------------------------------------
interface StoredProof { txHash: string; merklePaths: (string | null)[]; chainId?: number }

async function readProofCache(): Promise<Record<string, StoredProof>> {
  const { dapp_proof_cache } = await chrome.storage.local.get('dapp_proof_cache')
  return (dapp_proof_cache as Record<string, StoredProof>) ?? {}
}

function writeProofCache(cache: Record<string, StoredProof>): void {
  chrome.storage.local.set({ dapp_proof_cache: cache }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Era BSR cache (chrome.storage.local)
// Key: chainId → EraBsrCache { stateRoot, fieldProof, histSummaries }.
// Stores all historical_summaries + a 5-6 hash field proof → stateRoot → Helios.
// Covers all eras; no per-era proof needed. Re-downloaded when Helios can no longer confirm stateRoot.
// ---------------------------------------------------------------------------
async function readEraBsrCache(): Promise<Record<number, EraBsrCache>> {
  const { era_bsr_cache } = await chrome.storage.local.get('era_bsr_cache')
  return (era_bsr_cache as Record<number, EraBsrCache>) ?? {}
}

// Dev settings (settings page). Absent keys fall back to the shipped defaults,
// which are all 'auto' — i.e. exactly the normal behaviour.
async function readDevSettings(): Promise<DevSettings> {
  const stored = await chrome.storage.sync.get(['devMode', 'forceMode', 'eraSource', 'stateSource', 'histSource'])
  return {
    devMode:     (stored.devMode as boolean | undefined) ?? DEFAULT_DEV_SETTINGS.devMode,
    forceMode:   (stored.forceMode as ForceMode | undefined) ?? DEFAULT_DEV_SETTINGS.forceMode,
    eraSource:   (stored.eraSource as EraSource | undefined) ?? DEFAULT_DEV_SETTINGS.eraSource,
    stateSource: (stored.stateSource as StateSource | undefined) ?? DEFAULT_DEV_SETTINGS.stateSource,
    histSource:  (stored.histSource as HistSource | undefined) ?? DEFAULT_DEV_SETTINGS.histSource,
  }
}

function writeEraBsrCache(cache: Record<number, EraBsrCache>): void {
  chrome.storage.local.set({ era_bsr_cache: cache }).catch(() => {})
}

// Base Helios cache — resolves after eth_getBalance warmup (~30-60s total).
// Used by beacon verification which needs Helios quickly within its 35s timeout.
function getOrCreateRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (!rpcCache.has(chain.chainId)) {
    // Set.delete returns true iff the chain was flagged for a fresh re-anchor,
    // clearing the flag atomically so only this create honors it.
    const p = createVerifiedRpc(chain, forceFreshAnchor.delete(chain.chainId))
    p.catch(() => {
      // Both consensus RPCs failed (likely rate-limited). Wait 60s before
      // allowing a retry — clearing immediately causes a tight hammering loop
      // that worsens 429s and keeps the page stuck on loading.
      setTimeout(() => {
        rpcCache.delete(chain.chainId)
        freshRpcCache.delete(chain.chainId)
        freshRpcReady.delete(chain.chainId)
      }, 60_000)
    })
    rpcCache.set(chain.chainId, p)
    // The fresh instance (OOS probe + keepalive restarts) exists only to serve dapp
    // eth_call reads. It is NOT spawned here: a static page needs Helios once, to
    // verify its calldata, and then nothing more — spawning the fresh probe for it
    // meant a permanent OOS/restart loop for a page that never makes a call.
    // It is created on demand instead: by ethRpcCall, or by the renderer's
    // warmup-helios / keepalive messages, both of which only fire for pages with
    // scripts. See getOrCreateFreshRpc callers.
  }
  return rpcCache.get(chain.chainId)!
}

// Fresh Helios cache — resolves after the base is ready AND a new block has
// been observed, resetting drift to near-zero. Used by ethRpcCall so dapp
// eth_call reads land on Helios well within the out-of-sync threshold.
function getOrCreateFreshRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (!freshRpcCache.has(chain.chainId)) {
    const p = getOrCreateRpc(chain).then(async rpc => {
      // Retry eth_blockNumber until execution state is past the out-of-sync guard.
      // waitSynced() confirms consensus but execution may be briefly behind — once
      // eth_blockNumber succeeds, the head is within the OOS threshold and Helios
      // can serve all calls. Fast 500ms retries (vs old 1s new-block wait).
      const t0 = Date.now()
      let lastLag = '?'
      let wedged = false
      for (let i = 0; i < 120; i++) {
        try {
          await rpc.request<string>('eth_blockNumber', [], true)  // quickFail — skip internal 3s retry
          if (i > 0) console.log(`[w3] Helios OOS probe resolved in ${Math.round((Date.now() - t0) / 1000)}s`)
          return rpc  // execution head confirmed live
        } catch (err: any) {
          if (!(err?.message ?? '').includes('out of sync')) return rpc  // non-OOS error, proceed
          lastLag = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
          if (Number(lastLag) >= OOS_RESTART_LAG_SECONDS) { wedged = true; break }
        }
        if (i > 0 && i % 10 === 0) {
          console.log(`[w3] Helios OOS probe still waiting (${Math.round((Date.now() - t0) / 1000)}s, ${lastLag}s behind)…`)
        }
        await new Promise(r => setTimeout(r, 500))
      }
      // Probe exhausted (or wedged). Clear self from the cache so the rejection
      // handler / next ping recreates a probe rather than returning this rejected
      // promise. Do NOT set freshRpcReady with an OOS instance.
      freshRpcCache.delete(chain.chainId)
      throw new Error(wedged ? `Helios OOS wedged (${lastLag}s behind)` : 'Helios OOS probe exhausted')
    })
    p.then(
      (rpc) => {
        freshRpcReady.set(chain.chainId, rpc)
        heliosSyncingSignaled.delete(chain.chainId)
        oosExhaustionCount.delete(chain.chainId)
        chrome.runtime.sendMessage({ type: 'helios-ready', chainId: chain.chainId }).catch(() => {})
        flushPendingReads(chain.chainId, rpc)
      },
      (err: any) => {
        heliosSyncingSignaled.delete(chain.chainId)
        const emsg = err?.message ?? ''
        if (emsg.includes('OOS wedged')) {
          // Evict the wedged WASM instance and re-probe on a fresh one now;
          // bootstrap re-anchors to the current finalized checkpoint, so the
          // replacement comes up current instead of 150s+ behind. 
          const n = (oosExhaustionCount.get(chain.chainId) ?? 0) + 1
          oosExhaustionCount.set(chain.chainId, n)
          // The replacement must re-anchor from a fresh finalized root — the
          // cached checkpoint survives eviction and would reproduce this wedge.
          forceFreshAnchor.add(chain.chainId)
          evictChainRpc(chain.chainId)
          if (n >= 3) {
            oosExhaustionCount.set(chain.chainId, 0)
            // Don't assume the consensus feed is stale here: a healthy feed with a
            // WASM instance wedged against it looks identical from this vantage. Probe
            // the real consensus head so the log records which failure this actually
            // is, then back off 15s regardless.
            void logConsensusLiveness(chain, emsg, n)
            setTimeout(() => getOrCreateFreshRpc(chain), 15_000)
          } else {
            console.warn(`[w3] ${emsg} — restarting WASM instance immediately (attempt ${n})`)
            getOrCreateFreshRpc(chain)
          }
        } else if (emsg.includes('OOS probe exhausted')) {
          const n = (oosExhaustionCount.get(chain.chainId) ?? 0) + 1
          oosExhaustionCount.set(chain.chainId, n)
          if (n >= 2) {
            // Execution head stuck across 2 full probe cycles (2 × 60s) —
            // the WASM instance is not recovering. Clear rpcCache to force a
            // fresh createVerifiedRpc on the next getOrCreateFreshRpc call.
            console.warn(`[w3] Helios OOS stuck (${n} exhaustions) — restarting WASM instance`)
            oosExhaustionCount.set(chain.chainId, 0)
            evictChainRpc(chain.chainId)
          }
          getOrCreateFreshRpc(chain)
        }
      },
    )
    freshRpcCache.set(chain.chainId, p)
  }
  return freshRpcCache.get(chain.chainId)!
}

function flushPendingReads(chainId: number, rpc: IVerifiedRpc) {
  const queue = pendingReads.get(chainId) ?? []
  pendingReads.delete(chainId)
  for (const fn of queue) fn(rpc)
}


function rendererFor(web3Url: string): string {
  return chrome.runtime.getURL('renderer.html') + '#' + web3Url
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Retrieve calldata from a local Portal node when the execution RPC doesn't
// have the historical transaction. Requires blockNumber + txIndex in the name record.
async function fetchCalldataFromPortal(
  portalRpc: string,
  chunk: TxRef,
  rpc: IVerifiedRpc,
) {
  const { calldata } = await getCalldataViaPortal(portalRpc, chunk.blockNumber, chunk.txIndex)
  // Block headers are available on pruned nodes even when tx data is gone.
  // transactions is a hash-string array since we request with fullTx=false.
  interface RpcBlock { hash: string; timestamp: string; transactions: string[] }
  const block = await rpc.request<RpcBlock>('eth_getBlockByNumber', [
    `0x${chunk.blockNumber.toString(16)}`, false,
  ])
  return {
    verified: true,
    blockNumber: chunk.blockNumber,
    blockHash: block.hash,
    blockTimestamp: parseInt(block.timestamp, 16),
    txHash: block.transactions[chunk.txIndex],
    txIndex: chunk.txIndex,
    trieVerified: true,
    headerVerified: false,
    calldata,
  }
}

// ---------------------------------------------------------------------------
// URL interception
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A committed top-level URL change invalidates the previous page's verification
  // for this tab. 
  if (changeInfo.url) {
    tabVerGen.set(tabId, (tabVerGen.get(tabId) ?? 0) + 1)
    clearBadge(tabId)
  }
  const url = changeInfo.url ?? tab.pendingUrl ?? tab.url ?? ''
  if (url.startsWith('w3://')) {
    // The tab may navigate again or close before this lands — swallow "No tab with id".
    chrome.tabs.update(tabId, { url: rendererFor(url) }).catch(() => {})
  }
})

// Drop per-tab verification state when a tab closes so a reused tab id can't
// surface a closed tab's stale proof.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVerGen.delete(tabId)
  clearBadge(tabId)
})

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  // Gate on Terms acceptance — send the user to onboarding until they agree.
  if (!(await agreementAccepted())) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
    return
  }
  const trimmed = text.trim()
  const url = trimmed.startsWith('w3://') ? trimmed : `w3://${trimmed}`
  if (disposition === 'currentTab') {
    chrome.tabs.update({ url: rendererFor(url) })
  } else {
    chrome.tabs.create({ url: rendererFor(url) })
  }
})

chrome.omnibox.onInputChanged.addListener((_text, suggest) => {
  suggest([{ content: 'w3://', description: 'Enter an ENS/GNS/WNS name (e.g. myapp.eth, myapp.gwei, or myapp.wei) or block:txIndex' }])
})

// ---------------------------------------------------------------------------
// Port-based handler — two-phase: show content fast, verify with Helios after.
// Ports keep the service worker alive; one-shot sendMessage gets killed mid-fetch.
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'web3-resolve') {
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === 'resolve') {
        const tabId = port.sender?.tab?.id
        // Any rejection that escapes twoPhaseResolve's own try blocks would otherwise
        // be an unhandled rejection that leaves the port open — the renderer then hangs
        // on "Loading…" forever. Surface it as an error and close the port instead.
        twoPhaseResolve(message.url, tabId, port).catch((err) => {
          console.error('[w3] twoPhaseResolve crashed:', err)
          try { port.postMessage({ type: 'error', message: `Internal error: ${(err as Error).message}` }) } catch {}
          try { port.disconnect() } catch {}
        })
      }
    })
    return
  }

  if (port.name === 'helios-keepalive') {
    // Ping arrives every 10s from the renderer. Use it to health-check Helios:
    // one WASM eth_blockNumber call (no public RPC — Helios serves from its
    // internal cached head). If OOS, re-probe early before the dapp reads.
    //
    // The port itself is what keeps the service worker alive, so it stays open for
    // every page. But the health-check/restart work below is skipped unless the
    // page actually has scripts that can make eth calls.
    port.onMessage.addListener(async (msg) => {
      if (!(msg as { needsEth?: boolean } | undefined)?.needsEth) return
      const stored = await chrome.storage.sync.get('chains')
      const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
      for (const chain of Object.values(chains)) {
        if (chain.localMode) continue
        const rpc = freshRpcReady.get(chain.chainId)
        if (rpc) {
          // Health-check the live instance — cheap WASM call, no public RPC.
          try {
            await rpc.request<string>('eth_blockNumber', [], true)
          } catch (err: any) {
            if ((err?.message ?? '').includes('out of sync')) {
              if (freshRpcReady.get(chain.chainId) === rpc) {
                const lagStr = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
                const lag = Number(lagStr)
                // Only a lag far outside normal drift means the WASM is wedged in
                // internal backoff (see OOS_RESTART_LAG_SECONDS). Anything smaller
                // gets a cheap re-probe — Helios self-heals on the next update.
                const forceRestart = lag >= OOS_RESTART_LAG_SECONDS
                console.warn(`[w3] Helios keepalive OOS (${lagStr}s behind)${forceRestart ? ' — lag too large, forcing WASM restart' : ' — starting re-probe'}`)
                freshRpcReady.delete(chain.chainId)
                freshRpcCache.delete(chain.chainId)
                heliosSyncingSignaled.delete(chain.chainId)
                if (forceRestart) evictChainRpc(chain.chainId)
                getOrCreateFreshRpc(chain)
                chrome.runtime.sendMessage({ type: 'helios-oos', chainId: chain.chainId }).catch(() => {})
              }
            }
          }
        } else if (rpcCache.has(chain.chainId) && !freshRpcCache.has(chain.chainId)) {
          // Probe exhausted and cleared itself — restart it now rather than waiting
          // for the next ethRpcCall.
          getOrCreateFreshRpc(chain)
        }
      }
    })
    return
  }

  if (port.name === 'eth-request') {
    const tabId = port.sender?.tab?.id
    port.onMessage.addListener(async (msg) => {
      const resp = await handleEthRequest(msg.method, msg.params ?? [], msg.walletId, tabId)
      try { port.postMessage(resp) } catch {}
    })
  }
})

async function twoPhaseResolve(
  rawUrl: string,
  tabId: number | undefined,
  port: chrome.runtime.Port,
) {
  console.clear()
  console.log('[w3] twoPhaseResolve start', rawUrl)
  const send = (msg: BgResponse) => { try { port.postMessage(msg) } catch {} }

  // Per-tab generation: if a newer navigation starts for this tab before we finish,
  // discard our stale result rather than overwriting the badge/proof.
  const gen = tabId !== undefined ? (tabVerGen.get(tabId) ?? 0) + 1 : 0
  if (tabId !== undefined) tabVerGen.set(tabId, gen)
  const isSuperseded = () => tabId !== undefined && tabVerGen.get(tabId) !== gen
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const defaultChain = (stored.defaultChain as number | undefined) ?? 1
  const parsed = parseWeb3URL(rawUrl, defaultChain)
  console.log('[w3] parsed chainId:', parsed.chainId, 'target:', parsed.target)
  let chain = chains[parsed.chainId]
  if (!chain) {
    send({ type: 'error', message: `Unsupported chainId ${parsed.chainId}.` })
    port.disconnect()
    return
  }

  // Local mode: use only the first exec RPC at batch 1000, skip era/parquet
  const execRpcs = chain.localMode ? chain.rpcs.slice(0, 1) : chain.rpcs
  const execBatchSizes = chain.localMode
    ? (chain.rpcs[0] ? { [chain.rpcs[0]]: 1000 } : undefined)
    : chain.rpcBatchSizes

  // ── Phase 1: fetch via plain RPC, show content immediately ───────────────
  // Common to all 4 modes (see VERIFICATION.md) — name resolution, calldata parsing,
  // and the tx-trie rebuild that binds calldata to the block it's rendered from.
  console.log('[w3] Phase 1 — content fetch & assembly (plain RPC, not yet trusted)')
  if (tabId) setBadgeLoading(tabId)

  let assembled: Uint8Array
  let contentType: string
  let txHash: string
  let phase1BlockHash: string
  let phase1BlockNumber: number = 0
  let phase1TxIndex: number = 0
  // All chunk results — phase 2 verifies and binds every chunk, not just the last.
  let phase1Results: Array<VerificationResult & { block?: RpcBlockFull }> = []
  let phase1UsedPortal = false
  let phase1PortalFailed = false
  let phase1EnsChunks: TxRef[] = []
  let ensVerified: boolean | undefined = undefined

  // ── Name resolution: tx-calldata (`w3` record) vs contract-served (ERC-6821) ─
  // A name may point at a `w3` tx-calldata record (existing path) or, via ERC-6821
  // contentcontract/addr, at a contract that serves the page (ERC-5219/8244). The
  // latter is a different pipeline entirely — dispatch and return.
  const fastRpc = new RpcClient(execRpcs)
  let preResolvedChunks: TxRef[] | undefined
  // Raw contract address (web3://0x…): no name resolution — serve the contract directly.
  if (parsed.target.type === 'contract') {
    await resolveContractServed(rawUrl, tabId, port, send, parsed, chains, { address: parsed.target.address }, isSuperseded)
    return
  }
  if (parsed.target.type === 'ens') {
    let resolution: NameResolution
    try {
      resolution = await resolveName(parsed.target.name, fastRpc)
    } catch (err) {
      if (tabId) clearBadge(tabId)
      // A name with only a contenthash (no w3/contentcontract/addr) is an IPFS site →
      // flag it so a gateway-link navigation opens the gateway instead of erroring.
      const ipfs = await nameIsIpfs(parsed.target.name, new RpcClient(execRpcs)).catch(() => false)
      send({ type: 'error', message: (err as Error).message, ipfs })
      port.disconnect()
      return
    }
    if (resolution.kind === 'contract') {
      await resolveContractServed(rawUrl, tabId, port, send, parsed, chains, resolution, isSuperseded)
      return
    }
    preResolvedChunks = resolution.chunks
  }

  try {
    const target = parsed.target

    const txRefs: TxRef[] = target.type === 'tx'
      ? target.refs.map(r => ({ blockNumber: r.blockNumber, txIndex: r.txIndex }))
      : preResolvedChunks!
    phase1EnsChunks = txRefs
    const results = await Promise.all(txRefs.map(async (chunk) => {
      // Block-indexed record — use Portal or direct block fetch
      if (chain.portalRpc && !isPortalLikelyDown()) {
        try {
          console.log('[w3] Block-indexed record — fetching from Portal')
          const result = await fetchCalldataFromPortal(chain.portalRpc, chunk, fastRpc)
          phase1UsedPortal = true
          return result
        } catch (portalErr) {
          console.warn('[w3] Portal unavailable, falling back to RPC:', portalErr)
          phase1PortalFailed = true
          portalLastFailedAt = Date.now()
        }
      }
      return await getVerifiedCalldataByLocation(chunk.blockNumber, chunk.txIndex, fastRpc)
    }))
    phase1Results = results
    const last = results[results.length - 1]
    txHash = last.txHash
    phase1BlockHash = last.blockHash
    phase1BlockNumber = last.blockNumber
    phase1TxIndex = last.txIndex
    const chunks = results.map((r) => parseCalldata(r.calldata))
    ;({ data: assembled, contentType } = await assembleContent(chunks))

    // Bundle: send raw bundle bytes to renderer — it handles file extraction and blob URLs
    // (inline <script> tags are blocked by extension CSP; renderer uses blob: URLs instead)
  } catch (err) {
    if (tabId) clearBadge(tabId)
    send({ type: 'error', message: (err as Error).message })
    port.disconnect()
    return
  }

  // Send content to renderer
  send({ type: 'content', assembled: Array.from(assembled), contentType })

  // Per-chunk refs for the proof panel — the singular proof fields describe the
  // last chunk; this lists every chunk that phase 2 verifies.
  const proofChunks = phase1Results.map(r => ({ blockNumber: r.blockNumber, txIndex: r.txIndex, txHash: r.txHash }))

  // Store partial proof immediately so popup has something during phase 2
  if (tabId) {
    chrome.storage.session.set({
      [`proof_${tabId}`]: {
        url: rawUrl, txHash, contentType,
        payloadSize: formatBytes(assembled.length),
        heliosBacked: false, trieVerified: false, pending: true,
        blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txIndex: phase1TxIndex,
        chunks: proofChunks,
      },
    })
  }

  // ── Phase 2: Helios verification in background ────────────────────────────
  if (!tabId) return

  // A newer navigation for this tab may have started while Phase 1 was in flight (e.g. a
  // double navigate() at boot). Phase 2 is the expensive part — a ~334 MB BeaconState download
  // and 60 s hash — so bail before starting it rather than racing a redundant pipeline whose
  // result the supersede guard would only discard at the badge write.
  if (isSuperseded()) {
    console.log('[w3] Phase 2 skipped — superseded by a newer navigation for this tab')
    port.disconnect()
    return
  }

  // ── Portal path: if a local Portal node is configured, use it first ───────
  // Portal nodes verify calldata ∈ tx ∈ block ∈ canonical chain before storing,
  // so a successful fetch from the user's own node needs no re-verification —
  // the beacon pipeline below is skipped entirely (portalVerified: true).
  if (chain.portalRpc && !phase1PortalFailed && !isPortalLikelyDown()) {
    console.log('[w3] Mode 3 — Portal-trusted: trying', chain.portalRpc)
    // Start Helios in parallel for ENS re-verification — skipped in local mode (no external calls).
    const portalHeliosPromise = (!chain.localMode && parsed.target.type === 'ens' && phase1EnsChunks.length > 0 && chain.consensusRpcs.length > 0)
      ? Promise.race([
          getOrCreateRpc(chain),
          new Promise<undefined>(r => setTimeout(() => r(undefined), 35_000)),
        ]).catch(() => undefined)
      : Promise.resolve(undefined)

    try {
      // Skip re-download if Phase 1 already fetched from Portal — same source, no new info.
      if (!phase1UsedPortal) {
        await getCalldataViaPortal(chain.portalRpc, phase1BlockNumber, phase1TxIndex)
      }
      const trieVerified = true  // Portal pre-verifies trie before storing
      console.log('[w3] Mode 3 — Portal-trusted: calldata ∈ tx ∈ block ∈ canonical chain delegated to Portal node', phase1UsedPortal ? '(Phase 1 already used Portal)' : '')

      const portalHeliosRpc = await portalHeliosPromise
      console.log('[w3] Mode 3 — ENS/GNS re-verification: helios rpc ready:', !!portalHeliosRpc, 'heliosBacked:', portalHeliosRpc?.isHeliosBacked())
      if (portalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens') {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, portalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          console.log('[w3] Mode 3 — ENS/GNS re-verification result:', ensVerified)
        } catch (e) {
          console.warn('[w3] Mode 3 — ENS/GNS re-verification error:', (e as Error).message)
          ensVerified = undefined
        }
      }

      const update: VerificationUpdate = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified,
        portalVerified: true,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash,
          txHash, txIndex: phase1TxIndex,
          contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
        },
      }
      console.log('[w3] Mode 3 — Portal-trusted: done, ensOk:', parsed.target.type !== 'ens' || ensVerified === true)
      if (isSuperseded()) { port.disconnect(); return }
      await updateBadge(tabId, update)
      send(update)
      port.disconnect()
      return
    } catch (err) {
      console.warn('[w3] Mode 3 — Portal-trusted: node unavailable, falling back —', (err as Error).message)
      portalLastFailedAt = Date.now()
    }
  }

  // ── Local mode: trie-verify via local exec RPC only — no external calls ──
  if (chain.localMode) {
    console.log('[w3] Mode 4 — Local mode: trusted to local execution RPC, no Helios/beacon/ENS check')
    const update: VerificationUpdate = {
      type: 'verification-update',
      heliosBacked: false,
      trieVerified: false,
      localMode: true,
      proof: {
        url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
        txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        chunks: proofChunks,
      },
    }
    if (isSuperseded()) { port.disconnect(); return }
    await updateBadge(tabId, update)
    send(update)
    port.disconnect()
    return
  }

  // Historical blocks (> ~27h old) are outside the EIP-2935 ring buffer — Helios
  // would only throw EIP-2935 for them anyway. Skip the expensive multi-combo
  // Helios init (up to 6 min with 12 combinations × 30s timeout) and go straight
  // to beacon verification.
  const EIP_2935_BUFFER_SECONDS = 8191 * 12
  // Gate on the OLDEST chunk: if any chunk is outside the ring, Helios would throw
  // EIP-2935 for it — go straight to beacon verification, which covers recent chunks
  // too (via the BeaconState rolling window).
  const oldestTimestamp = Math.min(...phase1Results.map(r => r.blockTimestamp))
  const blockIsHistorical = (Date.now() / 1000) - oldestTimestamp > EIP_2935_BUFFER_SECONDS

  // Look up per-dapp proof cache (era Merkle proofs, one per chunk) and chain-level
  // era BSR cache. Old single-merklePath entries lack merklePaths — treated as a miss.
  const [proofCache, eraBsrCache] = await Promise.all([readProofCache(), readEraBsrCache()])
  const cachedEntry = proofCache[rawUrl]
  const cachedProof: DappProofData | undefined = cachedEntry
    && Array.isArray(cachedEntry.merklePaths)
    && cachedEntry.merklePaths.length === phase1Results.length
    && (parsed.target.type === 'tx' || cachedEntry.txHash.toLowerCase() === txHash.toLowerCase())
    ? { merklePaths: cachedEntry.merklePaths } : undefined
  if (cachedProof) console.log('[w3] Dapp proof cache hit — skipping era file download')

  // Dev mode: pin the era block_roots source and/or the BeaconState source.
  // Off (or 'auto') leaves the normal fallback/race behaviour untouched.
  const dev = await readDevSettings()
  if (dev.devMode && (dev.forceMode !== 'auto' || dev.eraSource !== 'auto' || dev.stateSource !== 'auto' || dev.histSource !== 'auto')) {
    console.log(`[w3] Dev mode — mode: ${dev.forceMode}, era source: ${dev.eraSource}, BeaconState source: ${dev.stateSource}, historical_summaries: ${dev.histSource}`)
    if (dev.forceMode !== 'beacon' && (dev.eraSource !== 'auto' || dev.stateSource !== 'auto' || dev.histSource !== 'auto') && !blockIsHistorical) {
      console.warn('[w3] Dev mode — target is a recent block, so Mode 1 (Helios) will handle it and the ' +
        'era / BeaconState / historical_summaries sources will NOT be used. Set mode to "beacon" to force Mode 2.')
    }
  }

  // A cached proof or BSR skips the download the dev is trying to exercise, so a
  // pinned source also bypasses both caches — otherwise selecting e.g. parquet
  // would silently verify from cache and never touch parquet at all.
  const pinned = dev.devMode && (dev.eraSource !== 'auto' || dev.stateSource !== 'auto' || dev.histSource !== 'auto')
  if (pinned && (cachedProof || eraBsrCache[chain.chainId])) {
    console.log('[w3] Dev mode — bypassing proof/BSR cache so the pinned source actually runs')
  }

  const beaconOptions = {
    checkpointUrls: chain.checkpointUrls,
    eraFileUrls: chain.localMode ? [] : chain.eraFileUrls,
    parquetUrls: chain.localMode ? [] : chain.parquetUrls,
    rpcBatchSizes: execBatchSizes,
    cachedProof: pinned ? undefined : cachedProof,
    eraBsrCache: pinned ? undefined : eraBsrCache[chain.chainId],
    eraSource: dev.devMode ? dev.eraSource : 'auto' as const,
    stateSource: dev.devMode ? dev.stateSource : 'auto' as const,
    histSource: dev.devMode ? dev.histSource : 'auto' as const,
    shouldAbort: isSuperseded,  // bail out of the pipeline if a newer navigation supersedes us
  }

  // Dev mode can override the block-age gate. Without this, a recent target always
  // takes Mode 1 and the era / BeaconState source pins below are unreachable.
  const forceBeacon = dev.devMode && dev.forceMode === 'beacon'
  const forceHelios = dev.devMode && dev.forceMode === 'helios'
  const useBeacon = (blockIsHistorical || forceBeacon) && !forceHelios

  if (useBeacon && chain.consensusRpcs.length > 0) {
    console.log(forceBeacon && !blockIsHistorical
      ? '[w3] Mode 2 — Historical block, beacon-verified: FORCED by dev mode (block is recent enough for Mode 1)'
      : '[w3] Mode 2 — Historical block, beacon-verified: oldest chunk outside Helios\'s EIP-2935 ring, starting Helios in parallel for the anchor')
    // Pass Helios promise unawaited — verification runs immediately using fast consensus
    // anchor. Helios runs in parallel; its result is checked at the very end of
    // verifyViaBeacon to confirm the effective state root (heliosAnchored: true/false).
    const heliosPromise = Promise.race([
      getOrCreateRpc(chain),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 35_000)),
    ]).catch(() => undefined)

    let update: VerificationUpdate
    try {
      const beacon = await verifyViaBeacon(
        phase1Results.map(r => ({ executionHash: r.blockHash, blockTimestamp: r.blockTimestamp })),
        chain.chainId,
        chain.consensusRpcs,
        heliosPromise,
        execRpcs,
        beaconOptions,
      )
      console.log('[w3] Mode 2 — beacon pipeline done: heliosAnchored:', beacon.heliosAnchored, 'eraVerified:', beacon.eraVerified, `(${phase1Results.length} chunk(s))`)
      if (beacon.proofData) {
        proofCache[rawUrl] = { txHash, chainId: chain.chainId, ...beacon.proofData }
        writeProofCache(proofCache)
      }
      if (beacon.newBsrCache) {
        eraBsrCache[chain.chainId] = beacon.newBsrCache
        writeEraBsrCache(eraBsrCache)
      }
      // Every chunk's block object (the one whose calldata was rendered) is verified
      // end-to-end: trie root, header keccak → blockhash (beacon-pinned above), tx hash.
      let trieVerified = false
      try {
        for (const r of phase1Results) {
          const { txHash: verifiedTxHash } = await verifyTxInBlock(r.blockHash, r.txIndex, execRpcs, r.block)
          if (verifiedTxHash.toLowerCase() !== r.txHash.toLowerCase())
            throw new Error(`Tx hash mismatch at index ${r.txIndex}: block has ${verifiedTxHash}, expected ${r.txHash}`)
        }
        trieVerified = true
        console.log('[w3] Mode 2 — tx trie → header → blockhash verified for all chunks ✓')
      } catch (trieErr) {
        console.warn('[w3] Mode 2 — tx inclusion verification failed:', (trieErr as Error).message)
      }
      // heliosPromise is already settled — verifyViaBeacon awaited it internally
      const historicalHeliosRpc = await heliosPromise
      if (historicalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, historicalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          console.log('[w3] Mode 2 — ENS/GNS re-verification result:', ensVerified)
        } catch {
          ensVerified = undefined
        }
      }
      update = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified,
        beaconVerified: true,
        beaconHeliosAnchored: beacon.heliosAnchored,
        beaconEraVerified: beacon.eraVerified,
        beaconStateHashVerified: beacon.stateHashVerified,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
        },
      }
    } catch (beaconErr) {
      // Superseded by a newer navigation (or aborted mid-flight because of one) — a quiet,
      // expected outcome, not a failure. Drop this stale run without touching the badge.
      if ((beaconErr as Error).message === SUPERSEDED || isSuperseded()) {
        console.log('[w3] Mode 2 — discarded: superseded by a newer navigation for this tab')
        port.disconnect()
        return
      }
      console.error('[w3] Mode 2 — beacon pipeline failed:', beaconErr)
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
        },
      }
    }
    if (isSuperseded()) { port.disconnect(); return }
    await updateBadge(tabId, update)
    send(update)
    port.disconnect()
    return
  }

  console.log('[w3] Mode 1 — Recent block, Helios-verified: creating Helios RPC for chain', chain.chainId)
  let update: VerificationUpdate
  // Hoist so the EIP-2935 fallback can pass heliosRpc as an EIP-4788 anchor
  let heliosRpc: Awaited<ReturnType<typeof getOrCreateRpc>> | undefined

  try {
    // Keep the rejection reason — swallowing it left "Helios not available" as
    // the only clue for genuinely different failures (bootstrap 404, dead exec
    // RPC, rate limit), which is not enough to act on.
    let heliosInitErr: string | undefined
    heliosRpc = await Promise.race([
      getOrCreateRpc(chain).catch((e: unknown) => {
        heliosInitErr = (e as Error).message
        return undefined
      }),
      new Promise<undefined>(r => setTimeout(() => r(undefined), 35_000)),
    ])
    if (!heliosRpc) {
      throw new Error(heliosInitErr
        ? `Helios init failed — ${heliosInitErr}`
        : 'Helios not available (35s timeout — still syncing or consensus RPC unreachable)')
    }
    console.log('[w3] Mode 1 — got RPC, heliosBacked:', heliosRpc.isHeliosBacked())
    // Verify EVERY chunk through Helios and bind the phase-1 rendered bytes to the
    // Helios-verified calldata. Without the byte comparison, a fast RPC serving a
    // self-consistent forgery in phase 1 would render forged content while phase 2
    // green-lights the canonical tx at the same coordinates.
    let result!: Awaited<ReturnType<typeof getVerifiedCalldataByLocation>>
    for (let i = 0; i < phase1Results.length; i++) {
      const p1 = phase1Results[i]
      result = await getVerifiedCalldataByLocation(p1.blockNumber, p1.txIndex, heliosRpc)
      if (!bytesEqual(result.calldata, p1.calldata))
        throw new Error(`Rendered calldata mismatch: chunk ${i} (block ${p1.blockNumber}, tx ${p1.txIndex}) does not match Helios-verified calldata`)
    }
    console.log(`[w3] Mode 1 — render binding: ${phase1Results.length} chunk(s) verified, rendered bytes match Helios ✓`)

    if (parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
      try {
        const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
        ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
        console.log('[w3] Mode 1 — ENS/GNS re-verification result:', ensVerified)
      } catch {
        ensVerified = undefined
      }
    }

    update = {
      type: 'verification-update',
      heliosBacked: heliosRpc.isHeliosBacked(),
      trieVerified: result.trieVerified,
      ensVerified,
      proof: {
        url: rawUrl,
        blockNumber: result.blockNumber,
        blockHash: result.blockHash,
        txHash: result.txHash,
        txIndex: result.txIndex,
        contentType,
        payloadSize: formatBytes(assembled.length),
        chunks: proofChunks,
      },
    }
  } catch (err) {
    console.warn('[w3] Mode 1 — Recent block, Helios-verified: failed —', (err as Error).message)

    if (isEip2935Error(err) && chain.consensusRpcs.length > 0) {
      console.log('[w3] Mode 1 failed (EIP-2935, block outside Helios\'s ring) — falling back to Mode 2 — Historical block, beacon-verified')
      try {
        const beacon = await verifyViaBeacon(
          phase1Results.map(r => ({ executionHash: r.blockHash, blockTimestamp: r.blockTimestamp })),
          chain.chainId,
          chain.consensusRpcs,
          heliosRpc,
          execRpcs,
          beaconOptions,
        )
        console.log(
          '[w3] Mode 2 — beacon pipeline done: heliosAnchored:', beacon.heliosAnchored,
          'eraVerified:', beacon.eraVerified,
        )
        if (beacon.proofData) {
          proofCache[rawUrl] = { txHash, chainId: chain.chainId, ...beacon.proofData }
          writeProofCache(proofCache)
        }
        if (beacon.newBsrCache) {
          eraBsrCache[chain.chainId] = beacon.newBsrCache
          writeEraBsrCache(eraBsrCache)
        }
        let trieVerified2 = false
        try {
          for (const r of phase1Results) {
            const { txHash: verifiedTxHash } = await verifyTxInBlock(r.blockHash, r.txIndex, execRpcs, r.block)
            if (verifiedTxHash.toLowerCase() !== r.txHash.toLowerCase())
              throw new Error(`Tx hash mismatch at index ${r.txIndex}: block has ${verifiedTxHash}, expected ${r.txHash}`)
          }
          trieVerified2 = true
          console.log('[w3] Mode 2 — tx trie → header → blockhash verified for all chunks ✓')
        } catch (trieErr) {
          console.warn('[w3] Mode 2 — tx inclusion verification failed:', (trieErr as Error).message)
        }
        // heliosRpc synced but threw EIP-2935 on block lookup; ENS uses 'latest' so it works
        if (heliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
          try {
            const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
            ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
            console.log('[w3] Mode 2 — ENS/GNS re-verification result:', ensVerified)
          } catch {
            ensVerified = undefined
          }
        }
        update = {
          type: 'verification-update',
          heliosBacked: false,
          trieVerified: trieVerified2,
          beaconVerified: true,
          beaconHeliosAnchored: beacon.heliosAnchored,
          beaconEraVerified: beacon.eraVerified,
          beaconStateHashVerified: beacon.stateHashVerified,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
            chunks: proofChunks,
          },
        }
      } catch (beaconErr) {
        if ((beaconErr as Error).message === SUPERSEDED || isSuperseded()) {
          console.log('[w3] Mode 2 — discarded: superseded by a newer navigation for this tab')
          port.disconnect()
          return
        }
        console.error('[w3] Mode 2 — beacon pipeline also failed:', beaconErr)
        update = {
          type: 'verification-update',
          heliosBacked: false, trieVerified: false,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
            chunks: proofChunks,
          },
        }
      }
    } else {
      console.warn('[w3] Mode 1 failed and no fallback applies (not EIP-2935, or no consensus RPCs configured) — unverified')
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
        },
      }
    }
  }

  if (isSuperseded()) { port.disconnect(); return }
  await updateBadge(tabId, update)
  send(update)
  port.disconnect()
}

// ---------------------------------------------------------------------------
// Contract-served pages (ERC-5219 / ERC-8244, resolved via ERC-6821)
//
// Unlike the tx-calldata pipeline, the content is the return value of a view
// eth_call — a current-state read. So verification is simply: re-run the same call
// through Helios at the same pinned block and byte-compare. No trie/beacon/era, and
// no 27h boundary (an immutable old version contract verifies at any age, since it's
// just a current-state read of frozen bytecode).
// ---------------------------------------------------------------------------

async function resolveContractServed(
  rawUrl: string,
  tabId: number | undefined,
  port: chrome.runtime.Port,
  send: (msg: BgResponse) => void,
  parsed: ReturnType<typeof parseWeb3URL>,
  chains: Record<number, ChainConfig>,
  contract: { address: string; chainId?: number; chainLabel?: string },
  isSuperseded: () => boolean,
) {
  const address = contract.address

  // ERC-6821 lets `contentcontract` point at a contract on ANOTHER chain (a numeric
  // chainId, or an EIP-3770 short name like "w3q-g" = web3q). verum verifies against
  // Ethereum's Helios anchor, so it can't prove content on a different chain — resolve
  // the pointer (we read it), but refuse to serve what we can't verify, with the reason.
  const SAME_CHAIN_ALIASES: Record<number, string[]> = {
    1: ['eth', 'ethereum', 'mainnet'],
    11155111: ['sep', 'sepolia'],
  }
  let crossChain: string | undefined
  if (contract.chainLabel) {
    if (!(SAME_CHAIN_ALIASES[parsed.chainId] ?? []).includes(contract.chainLabel.toLowerCase()))
      crossChain = `chain "${contract.chainLabel}"`
  } else if (contract.chainId !== undefined && contract.chainId !== parsed.chainId) {
    crossChain = `chainId ${contract.chainId}`
  }
  if (crossChain) {
    if (tabId) clearBadge(tabId)
    send({ type: 'error', message: `${address} is on ${crossChain}, a different chain than the URL. verum only serves content it can verify against Ethereum's Helios anchor, so cross-chain content isn't supported.` })
    port.disconnect()
    return
  }

  const chainId = parsed.chainId
  const chain = chains[chainId]
  if (!chain) {
    if (tabId) clearBadge(tabId)
    send({ type: 'error', message: `Unsupported chainId ${chainId}.` })
    port.disconnect()
    return
  }
  const execRpcs = chain.localMode ? chain.rpcs.slice(0, 1) : chain.rpcs
  console.log('[w3] Contract-served (ERC-5219/8244) —', address, 'on chain', chainId)

  // ── Phase 1: plain-RPC eth_call, paint immediately ───────────────────────
  if (tabId) setBadgeLoading(tabId)
  let content: ContractContent
  let blockNumber = 0
  let blockHash = ''
  // Both the plain-RPC read and the Helios re-call use the 'finalized' tag — the same
  // pattern the ENS re-verification uses, which Helios serves reliably. (A concrete
  // historical block *number* is not reliably served by Helios and made the two reads
  // land on different state, which surfaced as a false "differs from Helios".)
  const blockTag = 'finalized'
  try {
    const fastRpc = new RpcClient(execRpcs)
    // Finalized block is only for the proof panel's block number/hash — not the call tag.
    const fin = await fastRpc.request<{ number: string; hash: string }>('eth_getBlockByNumber', ['finalized', false])
    blockNumber = parseInt(fin.number, 16)
    blockHash = fin.hash
    content = await fetchContractContent(fastRpc, address, parsed.path, blockTag)
  } catch (err) {
    if (tabId) clearBadge(tabId)
    // The contract didn't serve web3 content. If this was a NAME and it has an IPFS
    // contenthash, it's a traditional IPFS site (e.g. docs.zswap.wei) that verum can't
    // serve — flag it so the renderer opens the original gateway URL instead of erroring.
    // Only a real IPFS contenthash triggers this, not any resolution failure.
    let ipfs = false
    if (parsed.target.type === 'ens') {
      ipfs = await nameIsIpfs(parsed.target.name, new RpcClient(execRpcs)).catch(() => false)
    }
    send({ type: 'error', message: (err as Error).message, ipfs })
    port.disconnect()
    return
  }

  send({ type: 'content', assembled: Array.from(content.body), contentType: content.contentType })

  if (tabId) {
    chrome.storage.session.set({
      [`proof_${tabId}`]: {
        url: rawUrl, contentType: content.contentType,
        payloadSize: formatBytes(content.body.length),
        heliosBacked: false, trieVerified: false, pending: true,
        blockNumber, blockHash,
        contractAddress: address, cacheControl: content.cacheControl,
      },
    })
  }

  if (!tabId) return
  if (isSuperseded()) { port.disconnect(); return }

  // ── Phase 2: re-run through Helios at the same block, byte-compare ────────
  let update: VerificationUpdate
  try {
    if (chain.localMode) {
      console.log('[w3] Contract-served — local mode: trusted to local exec RPC, no Helios check')
      update = contractUpdate(rawUrl, address, content, blockNumber, blockHash,
        { heliosBacked: false, trieVerified: false, verified: true, localMode: true })
    } else {
      // Verify through Helios, byte-comparing the served body. The base Helios instance
      // can be evicted/restarted mid-call by the OOS-wedge machinery (155s-behind stale
      // consensus is common here) — that surfaces as "Provider has been shut down". Retry
      // a few times, each getting whatever instance is current, so a restart underneath us
      // lands the next attempt on the fresh (now-synced) instance instead of failing.
      let verified: ContractContent | undefined
      let heliosBackedFlag = false
      let lastErr: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        const heliosRpc = await Promise.race([
          getOrCreateRpc(chain),
          new Promise<undefined>(r => setTimeout(() => r(undefined), 35_000)),
        ]).catch(() => undefined)
        if (!heliosRpc) { lastErr = new Error('Helios not available (35s timeout — still syncing or consensus RPC unreachable)'); break }
        try {
          verified = await fetchContractContent(heliosRpc, address, parsed.path, blockTag)
          heliosBackedFlag = heliosRpc.isHeliosBacked()
          break
        } catch (e) {
          lastErr = e
          const m = ((e as Error)?.message ?? '').toLowerCase()
          const transient = m.includes('shut down') || m.includes('out of sync') || m.includes('wasm call timeout')
          if (!transient) throw e
          console.warn(`[w3] Contract-served — Helios instance restarted mid-verify (attempt ${attempt + 1}) — retrying`)
          await new Promise(r => setTimeout(r, 1500))
        }
      }
      if (!verified) throw lastErr ?? new Error('Helios verification failed')

      const match = bytesEqual(verified.body, content.body)
      console.log(match
        ? '[w3] Contract-served — Helios re-call matches rendered bytes ✓'
        : '[w3] Contract-served — Helios body MISMATCH (possible forgery or state drift)')
      update = contractUpdate(rawUrl, address, verified, blockNumber, blockHash,
        { heliosBacked: heliosBackedFlag && match, trieVerified: match, verified: match })
    }
  } catch (err) {
    // Helios errored / unavailable (e.g. sync timeout, or a concurrent-call WASM error) —
    // that's UNVERIFIED ("could not confirm"), NOT a forgery. Only a successful Helios call
    // that returns different bytes is a mismatch (verified:false above).
    console.warn('[w3] Contract-served — verification unavailable —', (err as Error).message)
    update = contractUpdate(rawUrl, address, content, blockNumber, blockHash,
      { heliosBacked: false, trieVerified: false, verified: undefined })
  }

  if (isSuperseded()) { port.disconnect(); return }
  await updateBadge(tabId, update)
  send(update)
  port.disconnect()
}

function contractUpdate(
  rawUrl: string,
  address: string,
  content: ContractContent,
  blockNumber: number,
  blockHash: string,
  flags: { heliosBacked: boolean; trieVerified: boolean; verified: boolean | undefined; localMode?: boolean },
): VerificationUpdate {
  return {
    type: 'verification-update',
    heliosBacked: flags.heliosBacked,
    trieVerified: flags.trieVerified,
    localMode: flags.localMode,
    // The byte-compare through Helios confirms both the name→contract resolution and
    // the served body. Reuse ensVerified as that signal — it gates the badge (updateBadge
    // requires it for a dotted-name target) and drives the popup's "Name → contract" row.
    ensVerified: flags.verified,
    proof: {
      url: rawUrl,
      blockNumber,
      blockHash,
      contentType: content.contentType,
      payloadSize: formatBytes(content.body.length),
      contractAddress: address,
      cacheControl: content.cacheControl,
    },
  }
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function setBadgeLoading(tabId: number) {
  // Tab may be gone by the time these land — swallow "No tab with id".
  chrome.action.setBadgeText({ text: '···', tabId }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#8b949e', tabId }).catch(() => {})
}

async function updateBadge(tabId: number, update: VerificationUpdate) {
  let isEnsTarget = false
  try { isEnsTarget = parseWeb3URL(update.proof.url).target.type === 'ens' } catch {}
  const ensOk = !isEnsTarget || update.ensVerified === true
  const portalTrusted  = update.portalVerified === true && ensOk
  const heliosVerified = update.heliosBacked && update.trieVerified && ensOk
  const beaconTrusted  = update.beaconVerified && update.beaconHeliosAnchored && (update.trieVerified ?? false) && ensOk
  const fullyVerified  = heliosVerified || portalTrusted || beaconTrusted || update.localMode === true
  const color = fullyVerified ? '#3fb950' : '#d29922'
  const text = fullyVerified ? '✓' : '✗'
  // Final verdict, labeled by which VERIFICATION.md mode actually applies —
  // badge conditions match that doc's trust-boundary table exactly.
  const modeLabel = update.localMode ? 'Mode 4 — Local mode'
    : heliosVerified || update.heliosBacked ? 'Mode 1 — Recent block, Helios-verified'
    : portalTrusted || update.portalVerified ? 'Mode 3 — Portal-trusted'
    : update.beaconVerified ? 'Mode 2 — Historical block, beacon-verified'
    : 'no mode succeeded'
  console.log(`[w3] Badge verdict: ${modeLabel} → ${fullyVerified ? '✓ verified' : '✗ unverified'} (ensOk=${ensOk})`)
  // Tab may have been closed before verification finished — swallow the rejection.
  await Promise.allSettled([
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
  ])
  // Store flat object with all fields so popup.ts can read everything directly
  await chrome.storage.session.set({
    [`proof_${tabId}`]: {
      heliosBacked: ensOk ? update.heliosBacked : false,
      trieVerified: update.trieVerified,
      localMode: update.localMode ?? false,
      portalVerified: portalTrusted,
      beaconVerified: ensOk ? (update.beaconVerified ?? false) : false,
      beaconHeliosAnchored: ensOk ? (update.beaconHeliosAnchored ?? false) : false,
      beaconEraVerified: update.beaconEraVerified ?? false,
      beaconStateHashVerified: update.beaconStateHashVerified ?? false,
      ensVerified: update.ensVerified ?? null,
      pending: false,
      ...update.proof,
    },
  })
}

function clearBadge(tabId: number) {
  // clearBadge runs from onUpdated/onRemoved where the tab may already be gone.
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {})
  chrome.storage.session.remove(`proof_${tabId}`)
}

// ---------------------------------------------------------------------------
// Wallet bridge — MetaMask (and compatible wallets) via direct background port.
// Other wallets (Rabby, Rainbow, etc.) are handled by WalletConnect embedded
// in the dApp itself; Chrome blocks cross-extension content script injection.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'list-wallets') {
    listAvailableWallets().then(sendResponse)
    return true
  }
  if (msg.type === 'eth-rpc') {
    ethRpcCall(msg.chainId, msg.method, msg.params ?? []).then(sendResponse)
    return true
  }
  if (msg.type === 'broadcast-raw-tx') {
    broadcastRawTx(msg.chainId, msg.rawTx, msg.endpoint ?? null).then(sendResponse)
    return true
  }
  if (msg.type === 'warmup-helios' && msg.chainId) {
    chrome.storage.sync.get('chains').then(stored => {
      const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
      const chain = chains[msg.chainId]
      if (chain && !chain.localMode) getOrCreateFreshRpc(chain)
    })
  }
  if (msg.type === 'helios-status' && msg.chainId) {
    sendResponse({
      ready: freshRpcReady.has(msg.chainId),
      syncing: freshRpcCache.has(msg.chainId) && !freshRpcReady.has(msg.chainId),
    })
    return true
  }
})

// Broadcast an already-signed raw tx. The dapp's fetch shim rerouted an
// eth_sendRawTransaction here and the user approved a target in the renderer:
//  - endpoint set  → POST to the dapp's own RPC (preserves MEV protection, e.g. mevblocker).
//    Sent from the service worker, which is not bound by the sandbox page CSP.
//  - endpoint null → broadcast via verum's configured RPC set.
async function broadcastRawTx(chainId: number, rawTx: string, endpoint: string | null): Promise<{ result?: unknown; error?: string }> {
  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rawTx] }),
      })
      const j = await res.json() as { result?: unknown; error?: { message?: string } }
      if (j.error) return { error: j.error.message ?? JSON.stringify(j.error) }
      return { result: j.result }
    } catch (err: any) {
      return { error: (err as Error).message ?? String(err) }
    }
  }
  const stored = await chrome.storage.sync.get('chains')
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const chain = chains[chainId]
  if (!chain) return { error: `No chain config for chainId ${chainId}` }
  try {
    const result = await new RpcClient(chain.rpcs).request<unknown>('eth_sendRawTransaction', [rawTx])
    return { result }
  } catch (err: any) {
    return { error: (err as Error).message ?? String(err) }
  }
}

// Thin shell: deduplicates identical concurrent reads synchronously (before any
// await) so that wagmi's parallel hydration calls don't each spawn a separate
// Helios request. The shared Promise covers both the queued and live-Helios paths.
function ethRpcCall(chainId: number, method: string, params: unknown[]): Promise<{ result?: unknown; error?: string }> {
  if (method === 'eth_chainId') return Promise.resolve({ result: '0x' + chainId.toString(16) })
  if (method === 'net_version') return Promise.resolve({ result: String(chainId) })

  const cacheKey = `${chainId}:${method}:${JSON.stringify(params)}`
  const existing = heliosInflight.get(cacheKey)
  if (existing) return existing

  const p = _ethRpcCall(chainId, cacheKey, method, params)
  heliosInflight.set(cacheKey, p)
  p.finally(() => heliosInflight.delete(cacheKey))
  return p
}

async function _ethRpcCall(chainId: number, cacheKey: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: string }> {
  const stored = await chrome.storage.sync.get('chains')
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const chain = chains[chainId]
  if (!chain) return { error: `No chain config for chainId ${chainId}` }

  // Local mode: no Helios — forward directly to the user's trusted execution RPC.
  // Also clear heliosSyncingSignaled so that if the user switches back to non-local
  // mode the badge is shown correctly (otherwise the stale flag suppresses it).
  if (chain.localMode) {
    heliosSyncingSignaled.delete(chain.chainId)
    try {
      const result = await new RpcClient(chain.rpcs.slice(0, 1)).request<unknown>(method, params)
      return { result }
    } catch (err: any) {
      return { error: (err as Error).message ?? String(err) }
    }
  }

  // Trusted-reads mode: forward runtime reads to the fast execution RPC, no Helios.
  // (Content was still Helios-verified at load; this only speeds up post-load reads)
  // Not cached in heliosReadCache — those results are unverified and
  // must not pollute the verified cache used by the Helios path.
  if (trustedReads) {
    try {
      const result = await new RpcClient(chain.rpcs).request<unknown>(method, params)
      return { result }
    } catch (err: any) {
      return { error: (err as Error).message ?? String(err) }
    }
  }

  // Ensure Helios sync is in flight so freshRpcReady gets populated eventually.
  getOrCreateFreshRpc(chain)
  const rpc = freshRpcReady.get(chain.chainId)
  if (!rpc) {
    if (!heliosSyncingSignaled.has(chain.chainId)) {
      heliosSyncingSignaled.add(chain.chainId)
      chrome.runtime.sendMessage({ type: 'helios-syncing', chainId: chain.chainId }).catch(() => {})
    }
    // Queue this read — flushed as a batch once Helios is ready.
    // Timeout after 45s so message channels don't stay open indefinitely;
    // resolve with stale cache or error so the dapp can handle it gracefully.
    return new Promise<{ result?: unknown; error?: string }>(resolve => {
      const timer = setTimeout(() => {
        resolve(heliosReadCache.has(cacheKey)
          ? { result: heliosReadCache.get(cacheKey) }
          : { error: 'Helios not ready (45s timeout)' })
      }, 45_000)
      const queue = pendingReads.get(chain.chainId) ?? []
      if (!pendingReads.has(chain.chainId)) pendingReads.set(chain.chainId, queue)
      queue.push(async (helios) => {
        clearTimeout(timer)
        const isCacheableQ = CACHEABLE_METHODS.has(method)
        const releaseQ = isCacheableQ ? null : await acquireEthCallSlot()
        try {
          const result = await helios.request<unknown>(method, params)
          if (isCacheableQ) {
            if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
            heliosReadCache.set(cacheKey, result)
          }
          resolve({ result })
        } catch (err: any) {
          resolve(heliosReadCache.has(cacheKey)
            ? { result: heliosReadCache.get(cacheKey) }
            : { error: (err as Error).message ?? String(err) })
        } finally {
          releaseQ?.()
        }
      })
    })
  }
  try {
    try {
      const isCacheable = CACHEABLE_METHODS.has(method)
      const release = isCacheable ? null : await acquireEthCallSlot()
      let result: unknown
      try {
        result = await rpc.request<unknown>(method, params)
      } finally {
        release?.()
      }
      if (isCacheable) {
        if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
        heliosReadCache.set(cacheKey, result)
      }
      return { result }
    } catch (innerErr: any) {
      if ((innerErr?.message ?? '').includes('out of sync')) {
        // Normal lag: re-probe the existing instance — Helios self-heals on the next
        // optimistic update and freshRpcReady gets re-set once eth_blockNumber
        // succeeds. Only a lag beyond OOS_RESTART_LAG_SECONDS means the execution
        // sync loop is wedged in internal backoff and won't recover by probing;
        // evict then (shutdown + delete, never delete alone — a leaked instance's
        // polling loops starve the SW event loop) so a fresh WASM starts immediately.
        // Only the first concurrent OOS caller does this (the rest see undefined !== rpc
        // once freshRpcReady is cleared).
        if (freshRpcReady.get(chain.chainId) === rpc) {
          const lagStr = (innerErr.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
          const lag = Number(lagStr)
          const forceRestart = lag >= OOS_RESTART_LAG_SECONDS
          console.warn(`[w3] Helios OOS (${lagStr}s behind)${forceRestart ? ' — forcing WASM restart' : ' — starting re-probe'}`)
          freshRpcReady.delete(chain.chainId)
          freshRpcCache.delete(chain.chainId)
          heliosSyncingSignaled.delete(chain.chainId)
          if (forceRestart) evictChainRpc(chain.chainId)
          getOrCreateFreshRpc(chain)
          chrome.runtime.sendMessage({ type: 'helios-oos', chainId: chain.chainId }).catch(() => {})
        }
        // Serve stale verified result if available.
        if (heliosReadCache.has(cacheKey)) return { result: heliosReadCache.get(cacheKey) }
        // Re-queue only small primitive reads (eth_blockNumber, eth_getBalance, …).
        // eth_call and similar can return megabytes; accumulating 20+ concurrent
        // callers on the same promise then flushing them all at once sends 20 copies
        // of large data to the renderer simultaneously → structured-clone OOM.
        // For large-result methods, return the OOS error now — wagmi will retry
        // automatically when helios-ready fires after the probe recovers.
        if (CACHEABLE_METHODS.has(method)) {
          return new Promise<{ result?: unknown; error?: string }>(resolve => {
            const queue = pendingReads.get(chain.chainId) ?? []
            if (!pendingReads.has(chain.chainId)) pendingReads.set(chain.chainId, queue)
            queue.push(async (helios) => {
              try {
                const result = await helios.request<unknown>(method, params)
                if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
                heliosReadCache.set(cacheKey, result)
                resolve({ result })
              } catch (err: any) {
                resolve(heliosReadCache.has(cacheKey)
                  ? { result: heliosReadCache.get(cacheKey) }
                  : { error: (err as Error).message ?? String(err) })
              }
            })
          })
        }
      }
      throw innerErr
    }
  } catch (err: any) {
    return { error: err.message ?? String(err) }
  }
}

async function listAvailableWallets(): Promise<Array<{ name: string; id: string }>> {
  const [direct, frame] = await Promise.all([
    listWallets(),
    isFrameAvailable(),
  ])
  return frame ? [...direct, { name: 'Frame', id: '__frame__' }] : direct
}

// Per-wallet open-connection tracking, keyed by tab. The shared wallet (MetaMask/Frame)
// is one connection behind every open dapp, so a dapp's disconnect (wallet_revokePermissions)
// must only tear down that shared grant when it's the LAST tab using the wallet — otherwise
// disconnecting one dapp revokes the wallet for every other open dapp. Separate sets per
// walletId keep MetaMask and Frame counted independently.
const walletTabs = new Map<string, Set<number>>()
function registerWalletTab(walletId: string, tabId: number | undefined) {
  if (tabId === undefined) return
  if (!walletTabs.has(walletId)) walletTabs.set(walletId, new Set())
  walletTabs.get(walletId)!.add(tabId)
}
// Drops the tab and returns true if this was the LAST open connection for that wallet.
function releaseWalletTab(walletId: string, tabId: number | undefined): boolean {
  const set = walletTabs.get(walletId)
  if (!set) return true
  if (tabId !== undefined) set.delete(tabId)
  if (set.size === 0) { walletTabs.delete(walletId); return true }
  return false
}
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const set of walletTabs.values()) set.delete(tabId)
})

const CONNECT_METHODS_BG = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])

async function handleEthRequest(method: string, params: unknown[], walletId: string, tabId?: number): Promise<unknown> {
  // Disconnect: forward the revoke to the wallet only when this is the last open connection.
  // Otherwise drop just this tab and report success — the dapp disconnects locally without
  // tearing down the shared wallet grant that other open dapps still rely on.
  if (method === 'wallet_revokePermissions') {
    if (!releaseWalletTab(walletId, tabId)) return { result: null }
  }
  try {
    const result = walletId === '__frame__'
      ? await frameRequest(method, params)
      : await walletRequest(walletId, method, params)
    // Count the tab once its connect succeeds, so the counter reflects live grants.
    if (CONNECT_METHODS_BG.has(method)) registerWalletTab(walletId, tabId)
    return { result }
  } catch (err: any) {
    return { error: err.message ?? String(err) }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}
