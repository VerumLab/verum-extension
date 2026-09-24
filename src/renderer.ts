import { formatWeb3URL, parseWeb3URL } from './lib/w3/url-parser.js'
import { parseBundle, bundleFileAt } from './lib/w3/content.js'
import { buildWebsiteHtml } from './lib/w3/website-html.js'
import { startRocketGame, stopRocketGame } from './rocket-game.js'
import { AGREEMENT_VERSION } from './types.js'
import type { BgMessage, BgResponse, VerificationUpdate } from './types.js'

const splash          = document.getElementById('splash') as HTMLDivElement
const loading         = document.getElementById('loading') as HTMLDivElement
const loadingText     = document.getElementById('loading-text') as HTMLParagraphElement
const errorPanel      = document.getElementById('error-panel') as HTMLDivElement
const errorMessage    = document.getElementById('error-message') as HTMLPreElement
const websiteHost        = document.getElementById('website-host') as HTMLDivElement
const websiteFrame       = document.getElementById('website-frame') as HTMLIFrameElement
const rawView         = document.getElementById('raw-view') as HTMLDivElement
const warningBanner   = document.getElementById('warning-banner') as HTMLDivElement
const warningText     = document.getElementById('warning-text') as HTMLSpanElement
const warningDismiss  = document.getElementById('warning-dismiss') as HTMLButtonElement
const verifyBadge     = document.getElementById('verify-badge') as HTMLDivElement
const verifyIcon      = document.getElementById('verify-icon') as HTMLSpanElement
const verifyLabel     = document.getElementById('verify-label') as HTMLSpanElement
const heliosBadge     = document.getElementById('helios-badge') as HTMLDivElement

function showWarning() {
  warningBanner.classList.remove('hidden')
  websiteHost.classList.add('with-warning')
  rawView.classList.add('with-warning')
}

warningDismiss.addEventListener('click', () => {
  warningBanner.classList.add('hidden')
  websiteHost.classList.remove('with-warning')
  rawView.classList.remove('with-warning')
})

type Phase = 'idle' | 'loading' | 'ok' | 'error'

let pageHasScripts = false
let renderMode: 'website' | 'raw' = 'website'
let rawBlobUrl: string | null = null
let listingBlobUrls: string[] = []
let bundleCache: { key: string; data: Uint8Array } | null = null
let lastVerification: VerificationUpdate | null = null

function bundleCacheKey(parsed: ReturnType<typeof parseWeb3URL>): string {
  if (parsed.target.type === 'tx') {
    return parsed.target.refs.map(r => `${r.blockNumber}:${r.txIndex}`).join('+')
  }
  const host = parsed.target.type === 'contract' ? parsed.target.address : parsed.target.name
  return `${parsed.chainId}:${host}`
}

function setPhase(phase: Phase) {
  splash.classList.toggle('hidden',      phase !== 'idle')
  loading.classList.toggle('hidden',     phase !== 'loading')
  errorPanel.classList.toggle('hidden',  phase !== 'error')
  if (phase === 'error') startRocketGame(errorPanel); else stopRocketGame()
  websiteHost.classList.toggle('website-visible', phase === 'ok' && renderMode === 'website')
  rawView.classList.toggle('raw-visible', phase === 'ok' && renderMode === 'raw')
  verifyBadge.classList.toggle('hidden', phase !== 'ok')
  if (phase !== 'ok') heliosBadge.classList.add('hidden')
  if (phase === 'ok') {
    verifyBadge.className = 'syncing'
    verifyIcon.textContent = '⟳'
    verifyLabel.textContent = 'Verifying…'
    const contentLabel = renderMode === 'raw' ? 'file' : 'website'
    unverifiedModalMsg.textContent = `This ${contentLabel} is still being verified. Content authenticity is not yet confirmed.`
    unverifiedGate.classList.toggle('hidden', !pageHasScripts && renderMode !== 'raw')
    unverifiedModal.classList.add('hidden')
  } else {
    unverifiedGate.classList.add('hidden')
    unverifiedModal.classList.add('hidden')
  }
}

const unverifiedGate         = document.getElementById('unverified-gate') as HTMLDivElement
const unverifiedModal        = document.getElementById('unverified-modal') as HTMLDivElement
const unverifiedModalBackdrop = document.getElementById('unverified-modal-backdrop') as HTMLDivElement
const unverifiedModalMsg     = document.getElementById('unverified-modal-msg') as HTMLParagraphElement
const unverifiedModalCancel  = document.getElementById('unverified-modal-cancel') as HTMLButtonElement
const unverifiedModalAccept  = document.getElementById('unverified-modal-accept') as HTMLButtonElement

unverifiedGate.addEventListener('click', () => unverifiedModal.classList.remove('hidden'))
unverifiedModalBackdrop.addEventListener('click', () => unverifiedModal.classList.add('hidden'))
unverifiedModalCancel.addEventListener('click', () => unverifiedModal.classList.add('hidden'))
unverifiedModalAccept.addEventListener('click', () => {
  unverifiedGate.classList.add('hidden')
  unverifiedModal.classList.add('hidden')
})

const walletPicker         = document.getElementById('wallet-picker') as HTMLDivElement
const walletPickerBackdrop = document.getElementById('wallet-picker-backdrop') as HTMLDivElement
const walletPickerTitle    = document.getElementById('wallet-picker-title') as HTMLHeadingElement
const walletList           = document.getElementById('wallet-list') as HTMLDivElement
const frameToast         = document.getElementById('frame-toast') as HTMLDivElement
const frameToastClose    = document.getElementById('frame-toast-close') as HTMLButtonElement
const toastWalletLabel   = document.getElementById('toast-wallet-label') as HTMLSpanElement

frameToastClose.addEventListener('click', () => frameToast.classList.add('hidden'))

// ---------------------------------------------------------------------------
// Broadcast approval — raw tx broadcast target chooser (fetch-origin sends)
// ---------------------------------------------------------------------------

const broadcastModal    = document.getElementById('broadcast-modal') as HTMLDivElement
const broadcastBackdrop = document.getElementById('broadcast-backdrop') as HTMLDivElement
const broadcastDesc     = document.getElementById('broadcast-desc') as HTMLParagraphElement
const broadcastDetails  = document.getElementById('broadcast-details') as HTMLDivElement
const broadcastRememberCb = document.getElementById('broadcast-remember-cb') as HTMLInputElement
const broadcastEndpointHost = document.getElementById('broadcast-endpoint-host') as HTMLSpanElement
const broadcastCancel   = document.getElementById('broadcast-cancel') as HTMLButtonElement
const broadcastVerum    = document.getElementById('broadcast-verum') as HTMLButtonElement
const broadcastEndpoint = document.getElementById('broadcast-endpoint') as HTMLButtonElement

type BroadcastChoice = { useEndpoint: string | null }

// Per-website remembered broadcast target (keyed by w3:// host). Default off — the checkbox
// is unchecked each time, so a choice is remembered only when the user opts in.
const broadcastPrefs = new Map<string, 'endpoint' | 'verum'>()
chrome.storage.session.get('broadcastPrefs').then(v => {
  const p = v.broadcastPrefs as Record<string, 'endpoint' | 'verum'> | undefined
  if (p) for (const k in p) broadcastPrefs.set(k, p[k])
}).catch(() => {})
function persistBroadcastPrefs() {
  const obj: Record<string, string> = {}
  broadcastPrefs.forEach((v, k) => { obj[k] = v })
  chrome.storage.session.set({ broadcastPrefs: obj }).catch(() => {})
}

// Grant the website's endpoint host at broadcast time. Common RPC hosts are already in
// host_permissions (contains() → true, no prompt); anything else triggers Chrome's
// optional-permission prompt, which needs the user gesture from the approval click.
async function ensureHostPermission(endpoint: string): Promise<boolean> {
  try {
    const origin = new URL(endpoint).origin + '/*'
    if (await chrome.permissions.contains({ origins: [origin] })) return true
    return await chrome.permissions.request({ origins: [origin] })
  } catch { return false }
}

async function confirmBroadcast(rawTx: string, endpoint: string): Promise<BroadcastChoice | null> {
  const remembered = broadcastPrefs.get(currentPageUrl)
  if (remembered === 'verum') return { useEndpoint: null }
  if (remembered === 'endpoint') {
    return (await ensureHostPermission(endpoint)) ? { useEndpoint: endpoint } : null
  }

  let host = endpoint
  try { host = new URL(endpoint).host } catch {}
  broadcastEndpointHost.textContent = host
  broadcastDesc.textContent = 'This website wants to broadcast a signed transaction.'
  broadcastRememberCb.checked = false

  // Best-effort decode of the signed tx so the user sees where funds go before approving.
  broadcastDetails.innerHTML = ''
  const addRow = (label: string, value: string) => {
    const row = document.createElement('div')
    row.className = 'broadcast-row'
    const l = document.createElement('span'); l.className = 'broadcast-row-label'; l.textContent = label
    const v = document.createElement('span'); v.className = 'broadcast-row-value'; v.textContent = value
    row.append(l, v); broadcastDetails.appendChild(row)
  }
  addRow('Endpoint', host)
  const dec = decodeRawTx(rawTx)
  if (dec) {
    if (dec.to) addRow('To', dec.to)
    else addRow('To', 'Contract creation')
    addRow('Value', formatEth(dec.value) + ' ETH')
    if (dec.dataLen > 0) addRow('Data', dec.dataLen + ' bytes')
  } else {
    addRow('Details', 'Unable to decode — review endpoint')
  }

  return new Promise<BroadcastChoice | null>((resolve) => {
    const cleanup = () => {
      broadcastModal.classList.add('hidden')
      broadcastCancel.onclick = null
      broadcastVerum.onclick = null
      broadcastEndpoint.onclick = null
      broadcastBackdrop.onclick = null
    }
    const remember = (target: 'endpoint' | 'verum') => {
      if (broadcastRememberCb.checked) { broadcastPrefs.set(currentPageUrl, target); persistBroadcastPrefs() }
    }
    broadcastCancel.onclick = () => { cleanup(); resolve(null) }
    broadcastBackdrop.onclick = () => { cleanup(); resolve(null) }
    broadcastVerum.onclick = () => { remember('verum'); cleanup(); resolve({ useEndpoint: null }) }
    broadcastEndpoint.onclick = async () => {
      const ok = await ensureHostPermission(endpoint)
      if (!ok) { cleanup(); resolve(null); return }
      remember('endpoint'); cleanup(); resolve({ useEndpoint: endpoint })
    }
    broadcastModal.classList.remove('hidden')
  })
}

// Minimal signed-tx decoder (legacy + EIP-2930/1559/4844). Returns to/value/dataLen for
// the approval UI only — never used for verification. Best-effort; returns null on any
// malformed input rather than throwing.
function decodeRawTx(raw: string): { to: string | null; value: bigint; dataLen: number } | null {
  try {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw
    if (hex.length < 2) return null
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    let type = 0
    let payload = bytes
    if (bytes[0] >= 0x01 && bytes[0] <= 0x04) { type = bytes[0]; payload = bytes.slice(1) }
    const items = rlpDecodeList(payload)
    // Field offsets by tx type (fields before accessList are all we index):
    //  legacy:   [nonce, gasPrice, gasLimit, to, value, data, …]
    //  2930:     [chainId, nonce, gasPrice, gasLimit, to, value, data, …]
    //  1559/4844:[chainId, nonce, maxPrio, maxFee, gasLimit, to, value, data, …]
    const off = type === 0 ? { to: 3, val: 4, data: 5 }
      : type === 1 ? { to: 4, val: 5, data: 6 }
      : { to: 5, val: 6, data: 7 }
    const toB = items[off.to]
    const to = toB && toB.length ? '0x' + bytesToHex(toB) : null
    const value = items[off.val] ? bytesToBigInt(items[off.val]) : 0n
    const dataLen = items[off.data] ? items[off.data].length : 0
    return { to, value, dataLen }
  } catch { return null }
}

function rlpReadItem(b: Uint8Array, p: number): [Uint8Array, number] {
  const first = b[p]
  if (first < 0x80) return [b.slice(p, p + 1), p + 1]
  if (first < 0xb8) { const s = p + 1; const len = first - 0x80; return [b.slice(s, s + len), s + len] }
  if (first < 0xc0) { const ll = first - 0xb7; const len = bytesToNum(b.slice(p + 1, p + 1 + ll)); const s = p + 1 + ll; return [b.slice(s, s + len), s + len] }
  if (first < 0xf8) { const s = p + 1; const len = first - 0xc0; return [b.slice(s, s + len), s + len] }
  const ll = first - 0xf7; const len = bytesToNum(b.slice(p + 1, p + 1 + ll)); const s = p + 1 + ll
  return [b.slice(s, s + len), s + len]
}
function rlpDecodeList(b: Uint8Array): Uint8Array[] {
  const first = b[0]
  let start: number, end: number
  if (first >= 0xf8) { const ll = first - 0xf7; const len = bytesToNum(b.slice(1, 1 + ll)); start = 1 + ll; end = start + len }
  else if (first >= 0xc0) { const len = first - 0xc0; start = 1; end = 1 + len }
  else throw new Error('not an RLP list')
  const items: Uint8Array[] = []
  let p = start
  while (p < end) { const [content, next] = rlpReadItem(b, p); items.push(content); p = next }
  return items
}
function bytesToNum(b: Uint8Array): number { let n = 0; for (const x of b) n = n * 256 + x; return n }
function bytesToBigInt(b: Uint8Array): bigint { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n }
function bytesToHex(b: Uint8Array): string { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s }
function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = wei % 1_000_000_000_000_000_000n
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}.${fracStr.slice(0, 6)}`
}


// Keep-alive port: an open port resets Chrome's 30s SW idle timer natively
// without burning any RPC credits. Reconnects if the SW is killed and restarts.
function connectKeepalive() {
  const port = chrome.runtime.connect({ name: 'helios-keepalive' })
  // Ping every 10s — resets Chrome's SW idle timer AND (only for pages that can
  // make eth calls) gives the background a chance to health-check Helios with one
  // cheap WASM call. needsEth is false for plain HTML/image/PDF content, so the
  // background skips the Helios health-check and restart cycle entirely for it.
  const interval = setInterval(() => port.postMessage({ type: 'ping', needsEth: pageHasScripts }), 10_000)
  port.onDisconnect.addListener(() => { clearInterval(interval); setTimeout(connectKeepalive, 1_000) })
}
connectKeepalive()

// Intent-based warmup: signal the SW on user interaction so Helios has time to
// catch up the execution head before the user actually fires a contract read.
// Only for pages with scripts — a static page never reads, so warming the
// live-head instance for it is pure waste.
function warmupHelios() {
  if (currentChainId && pageHasScripts) {
    chrome.runtime.sendMessage({ type: 'warmup-helios', chainId: currentChainId }).catch(() => {})
  }
}
websiteHost.addEventListener('mouseenter', warmupHelios)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') warmupHelios()
})

// When Helios finishes syncing, trigger a re-fetch in the website so data that
// was served by the plain RpcClient gets replaced with verified Helios reads.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'helios-syncing' && msg.chainId === currentChainId && !currentLocalMode && !currentTrustedReads) {
    heliosBadge.classList.remove('hidden')
  }
  if (msg.type === 'helios-ready' && msg.chainId === currentChainId) {
    heliosIsReady = true
    heliosBadge.classList.add('hidden')
    websiteFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
  }
  if (msg.type === 'helios-oos' && msg.chainId === currentChainId && !currentLocalMode && !currentTrustedReads) {
    heliosIsReady = false
    heliosBadge.classList.remove('hidden')
  }
})

// ---------------------------------------------------------------------------
// Wallet bridge — eth requests from sandbox → background → chosen wallet
// ---------------------------------------------------------------------------

let selectedWalletId: string | null = null
let selectedWalletName: string = 'wallet'
let connectInProgress = false
let connectSuppressedUntil = 0
let currentChainId = 1
let currentPageUrl = ''
let currentFragment = ''
let pendingGatewayFallback = ''  // gateway URL to open if the target is an IPFS site
let currentLocalMode = false
let heliosIsReady = false
// Trusted-reads mode ("Helios reads" switched off): runtime reads bypass Helios, so the
// "updating Helios" badge is irrelevant and must not be shown. Mirrors the session flag.
let currentTrustedReads = true  // default: trusted RPC (see background.ts)
chrome.storage.session.get('trustedReads').then(v => {
  currentTrustedReads = v.trustedReads !== false
  if (currentTrustedReads) heliosBadge.classList.add('hidden')
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'trustedReads' in changes) {
    currentTrustedReads = changes.trustedReads.newValue !== false
    if (currentTrustedReads) heliosBadge.classList.add('hidden')
  }
})
// Queued connect requests that arrived while the picker was open.
// Resolved with the same result as the original to avoid spurious errors.
let connectWaiters: Array<(result: unknown, error?: string) => void> = []

const CONNECT_METHODS = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])

// Single-flight deduplication for idempotent read calls. When wagmi fires N
// identical eth_call requests simultaneously (one per React Query hook), only
// one message reaches the background — the rest attach to the same promise.
const ethReadInflight = new Map<string, Promise<{ result?: unknown; error?: string }>>()

const FRAME_APPROVAL_METHODS = new Set([
  'eth_sendTransaction', 'eth_sendRawTransaction',
  'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_requestAccounts', 'wallet_requestPermissions',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
])

window.addEventListener('message', async (e) => {
  if (!e.data) return
  if (e.source !== websiteFrame.contentWindow) return

  if (e.data.type === 'w3-navigate' && typeof e.data.url === 'string') {
    // Remember the gateway fallback for this navigation: if the target turns out to be an
    // IPFS site verum can't serve, we open this instead of showing an error.
    pendingGatewayFallback = typeof e.data.fallback === 'string' ? e.data.fallback : ''
    location.hash = e.data.url
    return
  }

  // Polyfill signals it's initialized. Only act if the page has scripts — simple HTML
  // pages get the polyfill too but won't make eth calls so the badge is irrelevant.
  if (e.data.type === 'polyfill-ready') {
    if (!pageHasScripts) return
    if (heliosIsReady) {
      websiteFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
    } else {
      chrome.runtime.sendMessage({ type: 'helios-status', chainId: currentChainId })
        .then((s: { ready: boolean; syncing: boolean } | undefined) => {
          if (!s) return
          if (s.ready) {
            heliosIsReady = true
            websiteFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
          }
        })
        .catch(() => {})
    }
    return
  }

  // wagmi calls provider.disconnect() when the user disconnects. Clear wallet state
  // immediately so subsequent eth_accounts checks return [] and wagmi doesn't reconnect.
  if (e.data.type === 'eth-disconnect') {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    websiteFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: [] },
      '*',
    )
    return
  }

  if (e.data.type !== 'eth-request') return
  const { id, method, params } = e.data

  const sendBack = (result: unknown, error?: string) =>
    websiteFrame.contentWindow?.postMessage({ type: 'eth-response', id, result, error }, '*')

  // Raw-fetch broadcast: the polyfill's fetch shim rerouted an eth_sendRawTransaction that
  // the website POSTed straight to a hardcoded RPC (e.g. mevblocker). The tx is already signed;
  // we only need the user to approve WHERE it goes — the website's endpoint (preserving MEV
  // protection) or verum's RPC set. `endpoint` is only ever set for these fetch-origin sends;
  // reads via fetch have no endpoint and fall through to the normal read path below.
  const endpoint: string | undefined = typeof e.data.endpoint === 'string' ? e.data.endpoint : undefined
  if (method === 'eth_sendRawTransaction' && endpoint) {
    const rawTx = (Array.isArray(params) ? params[0] : params) as string
    const choice = await confirmBroadcast(rawTx, endpoint)
    if (!choice) { sendBack(undefined, 'User rejected the request.'); return }
    const resp = await chrome.runtime.sendMessage({
      type: 'broadcast-raw-tx', chainId: currentChainId, rawTx, endpoint: choice.useEndpoint,
    })
    sendBack(resp?.result, resp?.error)
    return
  }

  // eth_chainId can always be answered from the URL — no wallet connection needed.
  // Returning "Not connected" here causes some websites to reset their connect UI.
  if (method === 'eth_chainId') {
    sendBack('0x' + currentChainId.toString(16))
    return
  }

  // eth_accounts returns the connected wallet's addresses, not a chain-state query.
  if (method === 'eth_accounts') {
    if (!selectedWalletId) { sendBack([]); return }
    // fall through to wallet path below
  } else if (method.startsWith('wallet_') && !FRAME_APPROVAL_METHODS.has(method)) {
    // wallet_* query methods (e.g. wallet_getPermissions, wallet_getCapabilities) must
    // go to the wallet — Helios has no concept of wallet state. When disconnected,
    // wallet_getPermissions returns [] (no permissions), which tells wagmi to request them.
    if (!selectedWalletId) {
      if (method === 'wallet_getPermissions') { sendBack([]); return }
      sendBack(undefined, 'Not connected'); return
    }
    // fall through to wallet path below
  } else if (!FRAME_APPROVAL_METHODS.has(method)) {
    // All eth_* reads always go through Helios regardless of wallet connection state —
    // ensures reads are verified against the URL's chain, not the wallet's active network.
    const inflightKey = `${currentChainId}:${method}:${JSON.stringify(params)}`
    let p = ethReadInflight.get(inflightKey)
    if (!p) {
      p = new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'eth-rpc', chainId: currentChainId, method, params })
          .then(resolve, reject)
      })
      p.finally(() => ethReadInflight.delete(inflightKey))
      ethReadInflight.set(inflightKey, p)
    }
    let resp: { result?: unknown; error?: string } | undefined
    try {
      resp = await p
    } catch (err: any) {
      console.error('[w3] eth-rpc sendMessage failed', method, err?.message)
      sendBack(undefined, err?.message ?? 'eth-rpc unavailable')
      return
    }
    if (resp === undefined) {
      console.error('[w3] eth-rpc no response for', method, params)
      sendBack(undefined, 'eth-rpc no response')
      return
    }
    sendBack(resp.result, resp.error)
    return
  }

  if (!selectedWalletId) {
    if (!CONNECT_METHODS.has(method)) {
      sendBack(undefined, 'Not connected'); return
    }
    // Websites auto-retry immediately after a wallet rejection. Suppress the picker
    // during a 1-second cooldown so cancelling doesn't reopen it right away.
    if (Date.now() < connectSuppressedUntil) {
      sendBack(undefined, 'User rejected the request.'); return
    }
    // If the picker is already open, queue this request instead of erroring.
    // Erroring concurrent connect calls causes some websites to reset their UI state.
    if (connectInProgress) {
      await new Promise<void>((resolve) => {
        connectWaiters.push((result, error) => { sendBack(result, error); resolve() })
      })
      return
    }
    connectInProgress = true
    const wallets = await chrome.runtime.sendMessage({ type: 'list-wallets' }) as Array<{ name: string; id: string }>
    if (!wallets || wallets.length === 0) {
      await pickWallet([])
      connectInProgress = false
      connectSuppressedUntil = Date.now() + 1000
      sendBack(undefined, 'No wallet found. Install MetaMask or Frame.')
      return
    }
    // Always show picker even for a single wallet — this requires explicit user
    // intent before we send eth_requestAccounts to MetaMask, preventing the
    // auto-retry loop when the website retries after a MetaMask rejection.
    const picked = await pickWallet(wallets)
    connectInProgress = false
    if (!picked) {
      connectSuppressedUntil = Date.now() + 1000
      sendBack(undefined, 'User rejected wallet selection')
      return
    }
    selectedWalletId = picked
    selectedWalletName = wallets.find(w => w.id === picked)?.name ?? 'wallet'
  }

  const needsApprovalToast =
    (selectedWalletId === '__frame__' && FRAME_APPROVAL_METHODS.has(method)) ||
    (selectedWalletId !== '__frame__' && method === 'eth_requestAccounts')

  let frameShowTimer: ReturnType<typeof setTimeout> | undefined
  let frameHideTimer: ReturnType<typeof setTimeout> | undefined
  if (needsApprovalToast) {
    frameShowTimer = setTimeout(() => {
      toastWalletLabel.textContent = `Approve in ${selectedWalletName}`
      frameToast.classList.remove('hidden')
      frameHideTimer = setTimeout(() => frameToast.classList.add('hidden'), 8000)
    }, 400)
  }

  // Use a port (not sendMessage) so the service worker stays alive while
  // waiting for MetaMask's user-approval popup. sendMessage allows the SW to
  // sleep mid-await, clearing the pending-callback map and losing the response.
  const resp = await new Promise<any>((resolve) => {
    const port = chrome.runtime.connect({ name: 'eth-request' })
    port.postMessage({ method, params, walletId: selectedWalletId })
    port.onMessage.addListener((msg) => { port.disconnect(); resolve(msg) })
    port.onDisconnect.addListener(() => resolve({ error: 'Wallet disconnected' }))
  })

  clearTimeout(frameShowTimer)
  clearTimeout(frameHideTimer)
  frameToast.classList.add('hidden')

  if (resp?.error && (resp.error === 'Wallet disconnected' || CONNECT_METHODS.has(method))) {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    if (CONNECT_METHODS.has(method) && resp.error !== 'Wallet disconnected') {
      connectSuppressedUntil = Date.now() + 1000
    }
  }

  // wallet_revokePermissions = disconnect. Clear wallet state and notify the website.
  if (!resp?.error && method === 'wallet_revokePermissions') {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    websiteFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: [] },
      '*',
    )
  }

  // EIP-1193: emit accountsChanged so websites that rely on the event update their UI.
  // wallet_requestPermissions is an alternative connect method — extract accounts from
  // the returned caveat so the website's accountsChanged listeners fire correctly.
  if (!resp?.error && method === 'eth_requestAccounts' && Array.isArray(resp?.result)) {
    websiteFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: resp.result },
      '*',
    )
  }
  if (!resp?.error && method === 'wallet_requestPermissions' && Array.isArray(resp?.result)) {
    type Perm = { parentCapability?: string; caveats?: Array<{ type?: string; value?: unknown }> }
    const perms = resp.result as Perm[]
    const ethPerm = perms.find(p => p.parentCapability === 'eth_accounts')
    const accounts = ethPerm?.caveats?.find(c => c.type === 'restrictReturnedAccounts')?.value
    if (Array.isArray(accounts) && accounts.length > 0) {
      websiteFrame.contentWindow?.postMessage(
        { type: 'wallet-event', method: 'accountsChanged', params: accounts },
        '*',
      )
    }
  }

  sendBack(resp?.result, resp?.error)

  // Resolve any connect calls that were queued while the picker was open.
  for (const w of connectWaiters.splice(0)) w(resp?.result, resp?.error)
})

// ---------------------------------------------------------------------------

const WALLET_ICONS: Record<string, { file: string; style?: string }> = {
  'MetaMask':       { file: 'icons/metamask.png' },
  'MetaMask Flask': { file: 'icons/metamask.png' },
  'Frame':          { file: 'icons/frame.png', style: 'filter:invert(1)' },
}

function walletIcon(name: string): string {
  const w = WALLET_ICONS[name]
  if (w) {
    const url = chrome.runtime.getURL(w.file)
    const style = ['border-radius:10px', w.style].filter(Boolean).join(';')
    return `<span class="wallet-icon"><img src="${url}" width="44" height="44" style="${style}" /></span>`
  }
  const label = name.slice(0, 2).toUpperCase()
  return `<span class="wallet-icon" style="background:#30363d;border-radius:10px;color:#fff;font-size:13px;font-weight:700">${label}</span>`
}

const PRIMARY_WALLETS = [
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Frame',    url: 'https://frame.sh' },
]

function pickWallet(wallets: Array<{ name: string; id: string }>): Promise<string | null> {
  return new Promise((resolve) => {
    const installedNames = new Set(wallets.map(w => w.name))
    const missing = PRIMARY_WALLETS.filter(w => !installedNames.has(w.name))

    walletPickerTitle.textContent = wallets.length === 0 ? 'No wallet found' : 'Select wallet'
    walletList.innerHTML = ''

    for (const w of wallets) {
      const btn = document.createElement('button')
      btn.className = 'wallet-option'
      btn.innerHTML = `${walletIcon(w.name)}<span>${w.name}</span>`
      btn.addEventListener('click', () => { walletPicker.classList.add('hidden'); resolve(w.id) })
      walletList.appendChild(btn)
    }

    for (const w of missing) {
      const btn = document.createElement('button')
      btn.className = 'wallet-option'
      btn.innerHTML = `${walletIcon(w.name)}<span>Get ${w.name}</span>`
      btn.addEventListener('click', () => { chrome.tabs.create({ url: w.url }); walletPicker.classList.add('hidden'); resolve(null) })
      walletList.appendChild(btn)
    }

    walletPickerBackdrop.onclick = () => { walletPicker.classList.add('hidden'); resolve(null) }
    walletPicker.classList.remove('hidden')
  })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------


// Monotonic navigation token. Each navigate() claims the next value; if a newer navigate()
// starts while an older one is still setting up, the older one sees its token is stale and
// bails before opening a second web3-resolve port (which would kick off a redundant, expensive
// Phase-2 pipeline in the background for the same tab).
let navSeq = 0

// Terms-of-Use gate: until the user accepts on the onboarding page, Verum loads
// nothing — redirect there instead of rendering any content.
void (async () => {
  const { agreement } = await chrome.storage.local.get('agreement') as { agreement?: { accepted?: boolean; version?: number } }
  if (!agreement?.accepted || (agreement.version ?? 0) < AGREEMENT_VERSION) {
    location.replace(chrome.runtime.getURL('onboarding.html'))
    return
  }
  const initialUrl = location.hash.slice(1)
  if (initialUrl) navigate(initialUrl)
  else setPhase('idle')
})()

window.addEventListener('hashchange', () => {
  const url = location.hash.slice(1)
  if (url) navigate(url)
  else setPhase('idle')
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function navigate(web3Url: string, attempt = 0) {
  const navToken = ++navSeq

  // Hide stale website content immediately — before any await — so the old website
  // never flashes through while storage is read or content arrives fast (local mode).
  websiteHost.classList.remove('website-visible')
  rawView.classList.remove('raw-visible')

  selectedWalletId = null
  selectedWalletName = 'wallet'
  connectInProgress = false
  connectSuppressedUntil = 0
  for (const w of connectWaiters.splice(0)) w(undefined, 'Navigation cancelled')

  let parsedUrl: ReturnType<typeof parseWeb3URL>
  try {
    const stored = await chrome.storage.sync.get(['defaultChain'])
    const defaultChain = (stored.defaultChain as number | undefined) ?? 1
    parsedUrl = parseWeb3URL(web3Url, defaultChain)
    currentChainId = parsedUrl.chainId
    // Host-only base for rewriting a website's self-referential share links (it builds them
    // from location.*, which is about:srcdoc in the sandbox). No path/hash — the website
    // appends its own.
    const host = parsedUrl.target.type === 'contract' ? parsedUrl.target.address
      : parsedUrl.target.type === 'ens' ? parsedUrl.target.name : ''
    currentPageUrl = `w3://${host}${parsedUrl.chainId !== 1 ? ':' + parsedUrl.chainId : ''}`
    // Fragment (#…) is website client-side state (share links). Carry it to the sandbox so
    // the website restores its state on load; parseWeb3URL strips it from resolution.
    const fragIdx = web3Url.indexOf('#')
    currentFragment = fragIdx !== -1 ? web3Url.slice(fragIdx) : ''
    heliosIsReady = false
    document.title = formatWeb3URL(parsedUrl)
  } catch (err) {
    showError(`Invalid URL: ${err}`)
    return
  }

  renderMode = 'website'
  if (rawBlobUrl) { URL.revokeObjectURL(rawBlobUrl); rawBlobUrl = null }
  for (const u of listingBlobUrls) URL.revokeObjectURL(u)
  listingBlobUrls = []
  rawView.innerHTML = ''
  websiteFrame.contentWindow?.postMessage({ type: 'render', html: '' }, '*')  // clear stale website

  // Same bundle, different path — render from cache without re-fetching or re-verifying.
  const cacheKey = bundleCacheKey(parsedUrl)
  if (bundleCache?.key === cacheKey) {
    renderBundle(bundleCache.data, web3Url)
    if (lastVerification) applyVerification(lastVerification)
    return
  }

  bundleCache = null
  lastVerification = null
  setPhase('loading')
  loadingText.textContent = 'Loading…'

  // A newer navigate() started while we were reading storage / parsing — don't open a second
  // resolve port; the newer one owns the tab now.
  if (navToken !== navSeq) return

  let contentReceived = false
  await new Promise<void>((resolve) => {
    const port = chrome.runtime.connect({ name: 'web3-resolve' })
    port.postMessage({ type: 'resolve', url: web3Url } as BgMessage)

    port.onMessage.addListener((msg: BgResponse) => {
      if (navToken !== navSeq) { resolve(); return }  // superseded — ignore this run's updates
      if (msg.type === 'error') {
        // IPFS site verum can't serve (e.g. docs.zswap.wei) — open its gateway in a new
        // tab and return to the page we came from, instead of stranding the user on an
        // error screen. Only when we came from a gateway link that gave us a fallback URL.
        if (msg.ipfs && pendingGatewayFallback) {
          const fb = pendingGatewayFallback
          pendingGatewayFallback = ''
          window.open(fb, '_blank')
          history.back()   // the w3-navigate pushed an entry; step back to the previous page
        } else {
          showError(msg.message)
        }
        resolve()
      } else if (msg.type === 'content') {
        contentReceived = true
        if (msg.contentType === 'application/x-w3fs-bundle') {
          const data = new Uint8Array(msg.assembled)
          bundleCache = { key: cacheKey, data }
          renderBundle(data, web3Url)
        } else {
          renderContent(new Uint8Array(msg.assembled), msg.contentType)
        }
        resolve()  // page shown — keep port open for verification update
      } else if (msg.type === 'verification-update') {
        lastVerification = msg
        applyVerification(msg)
      }
    })

    port.onDisconnect.addListener(() => resolve())
  })

  // SW was killed mid-flight before sending content — retry up to 2 times.
  // Chrome restarts the SW on the next connect(), so the first retry usually succeeds.
  if (!contentReceived) {
    if (attempt < 2) {
      navigate(web3Url, attempt + 1)
    } else {
      showError('Failed to load — service worker did not respond. Try reloading.')
    }
  }
}

// ---------------------------------------------------------------------------
// Verification update (arrives via port after Helios syncs)
// ---------------------------------------------------------------------------

function applyVerification(msg: VerificationUpdate) {
  let isEnsTarget = false
  try { isEnsTarget = parseWeb3URL(msg.proof.url).target.type === 'ens' } catch {}

  const ensTag = isEnsTarget ? ' · Name ✓' : ''
  const verified = (cls: string, label: string, delay = 2000) => {
    verifyBadge.className = cls
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = label
    setTimeout(() => verifyBadge.classList.add('hidden'), delay)
    unverifiedGate.classList.add('hidden')
  }
  if (msg.localMode) {
    currentLocalMode = true
    heliosBadge.classList.add('hidden')
    verified('verified', 'Local node — RPC trusted')
    return
  }
  currentLocalMode = false

  if (isEnsTarget && msg.ensVerified !== true) {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = msg.ensVerified === false
      ? 'Name forged — record differs from Helios'
      : 'Unverified — Name not confirmed by Helios'
    if (msg.ensVerified === false) {
      warningText.textContent = 'Name record mismatch — the RPC returned a different record than Helios confirmed. This may indicate a compromised RPC endpoint.'
      showWarning()
    }
    return
  }

  if (msg.portalVerified) {
    verified('portal', `Portal Network verified${ensTag}`)
  } else if (msg.heliosBacked && msg.trieVerified) {
    verified('verified', `Verified by Helios sync-committee${ensTag}`)
  } else if (msg.beaconVerified && msg.beaconHeliosAnchored) {
    verified('beacon', `Beacon verified — Helios anchor + Merkle proof${ensTag}`, 3000)
  } else if (msg.beaconVerified && msg.beaconEraVerified) {
    verified('beacon', `Beacon verified — era Merkle proof${ensTag}`, 3000)
  } else {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = 'Unverified — RPC trusted without proof'
    warningText.textContent = 'Block header unverified — content authenticity is NOT guaranteed. The RPC endpoint is trusted without cryptographic proof.'
    showWarning()
    const contentLabel = renderMode === 'raw' ? 'file' : 'website'
    unverifiedModalMsg.textContent = `This ${contentLabel} could not be verified against the blockchain. Its content may have been tampered with. Continue at your own risk.`
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Sandbox is loaded eagerly (src set in HTML). We wait for its load event before
// posting so website-sandbox.ts's message listener is guaranteed to be registered.
const sandboxReady = new Promise<void>(resolve =>
  websiteFrame.addEventListener('load', () => resolve(), { once: true })
)
function sendToSandbox(msg: object) {
  sandboxReady.then(() => websiteFrame.contentWindow?.postMessage(msg, '*'))
}

function renderBundle(data: Uint8Array, web3Url: string) {
  const parsed = parseWeb3URL(web3Url)
  const files = parseBundle(data)
  let file = bundleFileAt(files, parsed.path)

  // No index.html — show a directory listing so non-HTML bundles are navigable.
  // Rendered directly in raw-view (not the sandbox) so links update location.hash
  // and trigger navigate(). DOM construction avoids XSS from untrusted file paths.
  if (!file) {
    const isRoot = !parsed.path || parsed.path === '/'
    if (!isRoot) { showError(`Not found in bundle: ${parsed.path}`); return }

    renderMode = 'raw'
    rawView.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'raw-listing'
    const h2 = document.createElement('h2')
    h2.textContent = 'Bundle contents'
    wrap.appendChild(h2)
    const table = document.createElement('table')
    for (const f of files) {
      // All files get hash navigation links — renderBundle shows download UI for html/js
      const tr = document.createElement('tr')
      const tdPath = document.createElement('td')
      const a = document.createElement('a')
      a.href = `#${web3Url.replace(/\/$/, '')}${f.path}`
      a.textContent = f.path
      tdPath.appendChild(a)
      const tdMime = document.createElement('td')
      tdMime.textContent = f.mimeType
      const tdSize = document.createElement('td')
      tdSize.textContent = `${f.data.length.toLocaleString()} B`
      tr.append(tdPath, tdMime, tdSize)
      table.appendChild(tr)
    }
    wrap.appendChild(table)
    rawView.appendChild(wrap)
    pageHasScripts = false
    setPhase('ok')
    return
  }

  // Non-HTML entry file in bundle — pass through directly without HTML inlining.
  const entryMime = file.mimeType.toLowerCase().split(';')[0].trim()
  if (!entryMime.includes('html')) {
    renderContent(file.data, file.mimeType)
    return
  }

  // HTML accessed at an explicit path (not root/index entry): show download UI.
  // Avoids running untrusted HTML in the sandbox when navigating a file listing.
  if (parsed.path && parsed.path !== '/') {
    renderMode = 'raw'
    pageHasScripts = false
    rawBlobUrl = URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }))
    const dlName = file.path.split('/').pop() || file.path
    rawView.innerHTML =
      `<div class="raw-download">` +
      `<p>HTML file &nbsp;·&nbsp; ${file.data.length.toLocaleString()} bytes</p>` +
      `<a href="${rawBlobUrl}" download="${esc(dlName)}">Download ${esc(dlName)}</a>` +
      `</div>`
    setPhase('ok')
    return
  }

  const { html, assetMap } = buildWebsiteHtml(files, file)
  renderContent(new TextEncoder().encode(html), 'text/html', assetMap)
}

function renderContent(data: Uint8Array, contentType: string, assetMap: Record<string, string> = {}) {
  warningBanner.classList.add('hidden')
  websiteHost.classList.remove('with-warning')
  rawView.classList.remove('with-warning')

  // Normalise: strip parameters (e.g. "text/plain; charset=utf-8" → "text/plain")
  const ct = contentType.toLowerCase().split(';')[0].trim()

  // SAFETY GATE: text/html and */javascript MUST go through the sandboxed iframe,
  // never raw-view, to prevent extension-origin code execution.
  // Images are safe in rawView via <img> — browsers block script execution in SVGs
  // loaded via <img>. Blob URLs created here can't cross into the sandboxed iframe origin.
  const needsSandbox =
    ct.includes('html') ||
    ct.includes('javascript') ||
    ct.includes('json')

  if (!needsSandbox) {
    renderMode = 'raw'
    pageHasScripts = false

    if (ct === 'application/pdf') {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
      // Use a plain <iframe> (no sandbox attr) so Chrome's built-in PDF viewer activates.
      rawView.innerHTML = `<iframe src="${rawBlobUrl}"></iframe>`
    } else if (ct.startsWith('text/')) {
      rawView.innerHTML = `<div class="raw-text"><pre>${esc(new TextDecoder().decode(data))}</pre></div>`
    } else if (ct.startsWith('image/')) {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: ct }))
      rawView.innerHTML =
        `<div style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100%">` +
        `<img src="${rawBlobUrl}" style="max-width:100%;max-height:100vh"/>` +
        `</div>`
    } else {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: ct || 'application/octet-stream' }))
      rawView.innerHTML =
        `<div class="raw-download">` +
        `<p>Content type: <code>${esc(ct || 'unknown')}</code> &nbsp;·&nbsp; ${data.length.toLocaleString()} bytes</p>` +
        `<a href="${rawBlobUrl}" download>Download file</a>` +
        `</div>`
    }

    setPhase('ok')
    return
  }

  renderMode = 'website'
  let html: string
  if (ct.includes('html')) {
    html = new TextDecoder().decode(data)
  } else if (ct.includes('javascript')) {
    const code = new TextDecoder().decode(data)
    html = `<!DOCTYPE html><html><body><div id="root"></div><script type="module">${code}<\/script></body></html>`
  } else if (ct.includes('json')) {
    html = `<!DOCTYPE html><html><body><pre style="font-family:monospace;padding:16px">${esc(new TextDecoder().decode(data))}</pre></body></html>`
  } else {
    html = ''
  }

  pageHasScripts = /<script[\s>]/i.test(html)
  // Detect the OS color scheme reliably here (extension page), and pass it to the sandbox.
  // In a freshly-created srcdoc iframe, matchMedia('(prefers-color-scheme:dark)') can
  // return the wrong value at parse time, so websites reading it at init (zSwap) sometimes
  // render light. The sandbox shims matchMedia to return this value consistently.
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  sendToSandbox({ type: 'render', html, assetMap, chainId: currentChainId, pageUrl: currentPageUrl, fragment: currentFragment, prefersDark })
  // Now that we know the page can make eth calls, start the live-head Helios
  // instance — it is no longer spawned during verification, so without this the
  // website's first read would have to wait for the whole sync.
  if (pageHasScripts) warmupHelios()
  setPhase('ok')
}

// ---------------------------------------------------------------------------

function showError(msg: string) {
  errorMessage.textContent = ''
  const label = document.createElement('strong')
  label.textContent = 'Error'
  errorMessage.appendChild(label)
  errorMessage.appendChild(document.createTextNode(' ' + msg))
  setPhase('error')
}
// Full HTML escape — covers text AND attribute contexts. Quotes MUST be escaped because
// esc() output is interpolated into quoted attributes .
function esc(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
