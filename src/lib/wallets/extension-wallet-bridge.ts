// Wallet bridge — connects directly to installed wallet extensions via Chrome
// port messaging using MetaMask's object-multiplex JSON-RPC wire protocol.
// Detects ALL installed compatible wallets; caller decides which to use.

const PORT_NAME = 'metamask-contentscript'
const CHANNEL   = 'metamask-provider'
const PING_ID   = 0  // reserved id for protocol-compatibility ping

const KNOWN_WALLETS = [
  { name: 'MetaMask',        id: 'nkbihfbeogaeaoehlefnkodbefgpgknn' },
  { name: 'MetaMask Flask',  id: 'ljfoeinjpaedjfecknsskonlnkjgodld' },
  { name: 'Rabby',           id: 'acmacodkjbdgmoleebolmdjonilkdbch' },
  { name: 'Coinbase Wallet', id: 'hnfanknocfeofbddgcijnmhnfnkdfeoc' },
  { name: 'Rainbow',         id: 'opfgelmcmbiajamepnmloijbpoleiama' },
  { name: 'OKX Wallet',      id: 'mcohilncbfahbmgdjkbpemcciiolgcge' },
  { name: 'Phantom',         id: 'bfnaelmomeahhbjbkjpcbaefhddddgmn' },
]

interface DetectedWallet { name: string; id: string; port: chrome.runtime.Port }

let detectedCache: DetectedWallet[] | null = null
let detectingPromise: Promise<DetectedWallet[]> | null = null
let activePort: chrome.runtime.Port | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function sendRequest(method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!activePort) { reject(new Error('No active port')); return }
    const id = nextId++
    pending.set(id, { resolve, reject })
    try {
      activePort.postMessage({ name: CHANNEL, data: { jsonrpc: '2.0', id, method, params } })
    } catch (err) {
      pending.delete(id)
      reject(err)
    }
  })
}

function attachPort(port: chrome.runtime.Port) {
  activePort = port
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as { name?: string; data?: { id?: number; result?: unknown; error?: { message?: string } } }
    if (msg?.name !== CHANNEL || !msg.data) return
    const { id, result, error } = msg.data
    if (id == null || id === PING_ID) return
    const cb = pending.get(id)
    if (!cb) return
    pending.delete(id)
    if (error) cb.reject(new Error(error.message ?? JSON.stringify(error)))
    else cb.resolve(result)
  })
  port.onDisconnect.addListener(() => {
    activePort = null
    detectedCache = null
    // Defer so any response message that arrived in the same tick is processed first.
    setTimeout(() => {
      for (const cb of pending.values()) cb.reject(new Error('Wallet disconnected'))
      pending.clear()
    }, 0)
  })
}

function tryConnect(id: string): Promise<chrome.runtime.Port | null> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port
    try { port = chrome.runtime.connect(id, { name: PORT_NAME }) }
    catch { resolve(null); return }

    let settled = false
    const settle = (v: chrome.runtime.Port | null) => { if (!settled) { settled = true; resolve(v) } }
    // An installed wallet's MV3 service worker may be asleep: the connect() above wakes it,
    // but the ping response can lag ~1s on a cold start. A short timeout would report the
    // wallet as absent ("get MetaMask" while installed). An absent wallet is unaffected — it
    // fires onDisconnect immediately — so this only lengthens the wait for a waking wallet.
    const timer = setTimeout(() => settle(null), 1500)
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; clearTimeout(timer); settle(null) })
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as { name?: string; data?: { id?: number } }
      if (msg?.name !== CHANNEL || msg.data?.id !== PING_ID) return
      clearTimeout(timer)
      settle(port)
    })
    try {
      port.postMessage({ name: CHANNEL, data: { jsonrpc: '2.0', id: PING_ID, method: 'net_version', params: [] } })
    } catch { settle(null) }
  })
}

function detectAll(): Promise<DetectedWallet[]> {
  if (detectedCache !== null) return Promise.resolve(detectedCache)
  if (!detectingPromise) {
    detectingPromise = Promise.all(
      KNOWN_WALLETS.map(async (w) => {
        const port = await tryConnect(w.id)
        return port ? { name: w.name, id: w.id, port } : null
      })
    ).then((results) => {
      const found = results.filter((r): r is DetectedWallet => r !== null)
      detectedCache = found
      detectingPromise = null
      return found
    })
  }
  return detectingPromise
}

// Returns every installed wallet that speaks this protocol.
export async function listWallets(): Promise<Array<{ name: string; id: string }>> {
  detectedCache = null
  let wallets = await detectAll()
  // Retry once if nothing was found: the first probe's connect() wakes a sleeping wallet
  // service worker, so a second pass a moment later catches one that missed the first window.
  if (wallets.length === 0) {
    detectedCache = null
    wallets = await detectAll()
  }
  return wallets.map(w => ({ name: w.name, id: w.id }))
}

// Forward a JSON-RPC call to the specified wallet (by extension id).
// On first call, disconnects all unchosen wallet ports.
export async function ethRequest(walletId: string, method: string, params: unknown[]): Promise<unknown> {
  if (!activePort) {
    const wallets = await detectAll()
    if (wallets.length === 0) throw new Error('No compatible wallet found. Install MetaMask or another EIP-1193 wallet extension.')

    const target = wallets.find(w => w.id === walletId) ?? wallets[0]

    for (const w of wallets) {
      if (w !== target) w.port.disconnect()
    }
    detectedCache = [target]
    attachPort(target.port)
  }

  return sendRequest(method, params)
}
