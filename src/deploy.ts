// Deploy page — publish a file or folder as W3FS calldata from the extension.
// Wizard: select → preview (same sandbox as the renderer) → deploy via wallet
// (MetaMask/Frame through the existing background bridges) → verify through the
// normal web3-resolve pipeline → optionally link an owned .eth/.gwei/.wei name.

import { Interface, ensNormalize, namehash } from 'ethers'
import { formatWeb3URL } from './lib/w3/url-parser.js'
import { buildWebsiteHtml } from './lib/w3/website-html.js'
import type { BundleFile } from './lib/w3/content.js'
import {
  encodeBundle, encodeSingleFile, isSkippedPath, sniffType,
  toHex, txGasLimit, W3FS_DEPOSIT, type DeployFile,
} from './lib/w3/encoder.js'
import { DEFAULT_CHAINS, type BgResponse, type ChainConfig } from './types.js'

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const chainSelect   = $<HTMLSelectElement>('default-chain-select')
const chainLocked   = $('chain-locked')
const stepSelect    = $('step-select')
const stepPreview   = $('step-preview')
const stepDeploy    = $('step-deploy')
const stepVerify    = $('step-verify')
const stepName      = $('step-name')
const dropZone      = $('drop-zone')
const fileInput     = $<HTMLInputElement>('file-input')
const folderInput   = $<HTMLInputElement>('folder-input')
const previewFrame  = $<HTMLIFrameElement>('preview-frame')
const previewRaw    = $('preview-raw')
const walletConnect = $('wallet-connect')
const walletList    = $('wallet-list')
const accountLine   = $('account-line')
const switchAccountBtn = $<HTMLButtonElement>('switch-account')
const nameAccountLine  = $('name-account-line')
const nameSwitchBtn    = $<HTMLButtonElement>('name-switch-account')
const txList        = $<HTMLOListElement>('tx-list')
const deployError   = $('deploy-error')
const retryDeploy   = $<HTMLButtonElement>('retry-deploy')
const verifyStatus  = $('verify-status')
const verifyDetail  = $('verify-detail')
const openLink      = $<HTMLAnchorElement>('open-link')
const retryVerify   = $<HTMLButtonElement>('retry-verify')
const nameInput     = $<HTMLInputElement>('name-input')
const linkNameBtn   = $<HTMLButtonElement>('link-name')
const nameStatus    = $('name-status')
const nameDone      = $('name-done')
const nameLink      = $<HTMLAnchorElement>('name-link')
const coordsBlock   = $('coords-block')
const coordsInput   = $<HTMLInputElement>('coords-input')
const walletModal   = $('wallet-modal')
const walletModalList = $('wallet-modal-list')
const walletModalTitle = $('wallet-modal-title')

folderInput.webkitdirectory = true

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let chain: ChainConfig | undefined
let isDirectory = false
let selectionLabel = ''
let entries: DeployFile[] = []           // selected files (bundle-relative paths)
let calldatas: Uint8Array[] = []         // one per transaction
let selectedWalletId: string | null = null
let account: string | null = null
let nextTxIndex = 0                      // resume point for retry
let coords: Array<{ blockNumber: number; txIndex: number }> = []
let deployedUrl = ''
let allChains: Record<number, ChainConfig> = {}

// ---------------------------------------------------------------------------
// Boot: chain selector + warm up Helios for the verification step later
// ---------------------------------------------------------------------------

async function boot() {
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  allChains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const defaultChain = (stored.defaultChain as number | undefined) ?? 1

  chainSelect.innerHTML = ''
  for (const c of Object.values(allChains)) {
    const opt = document.createElement('option')
    opt.value = String(c.chainId)
    opt.textContent = `${c.name} (${c.chainId})`
    if (c.chainId === defaultChain) opt.selected = true
    chainSelect.appendChild(opt)
  }
  selectChain(defaultChain)
}
boot()

function selectChain(chainId: number) {
  chain = allChains[chainId]
  if (chain && !chain.localMode) {
    chrome.runtime.sendMessage({ type: 'warmup-helios', chainId: chain.chainId }).catch(() => {})
  }
}

// Same behaviour as the settings page: the selection IS the default chain, so
// it persists and w3:// navigation without a chainId prefix uses it too.
chainSelect.addEventListener('change', () => {
  const chainId = parseInt(chainSelect.value, 10)
  chrome.storage.sync.set({ defaultChain: chainId })
  selectChain(chainId)
  // A wallet connected to the old chain must re-switch before the next tx;
  // ensureChain() handles that, but drop the cost estimate's stale gas price.
  if (calldatas.length > 0) estimateCost()
})

// Once the first transaction is sent the coordinates are bound to that chain —
// switching mid-deploy would produce a URL pointing at the wrong network.
function lockChainSelector() {
  chainSelect.disabled = true
  chainLocked.classList.remove('hidden')
}

// ---------------------------------------------------------------------------
// Step 1 — select
// ---------------------------------------------------------------------------

$('pick-file').addEventListener('click', () => fileInput.click())
$('pick-folder').addEventListener('click', () => folderInput.click())

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (f) await selectSingleFile(f)
  fileInput.value = ''
})

folderInput.addEventListener('change', async () => {
  const files = Array.from(folderInput.files ?? [])
  if (files.length) await selectFolderFiles(files)
  folderInput.value = ''
})

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const item = e.dataTransfer?.items?.[0]
  if (!item) return
  const entry = item.webkitGetAsEntry?.()
  if (entry?.isDirectory) {
    const collected = await readDirEntry(entry as FileSystemDirectoryEntry, '')
    if (collected.length) await selectEntries(collected, entry.name, true)
    return
  }
  const f = e.dataTransfer?.files?.[0]
  if (f) await selectSingleFile(f)
})

// Recursively read a dropped directory into bundle-relative DeployFiles.
function readDirEntry(dir: FileSystemDirectoryEntry, prefix: string): Promise<DeployFile[]> {
  return new Promise((resolve) => {
    const reader = dir.createReader()
    const out: Promise<DeployFile[]>[] = []
    const readBatch = () => reader.readEntries(async (batch) => {
      if (batch.length === 0) {
        resolve((await Promise.all(out)).flat())
        return
      }
      for (const entry of batch) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (isSkippedPath(rel)) continue
        if (entry.isDirectory) {
          out.push(readDirEntry(entry as FileSystemDirectoryEntry, rel))
        } else {
          out.push(new Promise<DeployFile[]>((res) =>
            (entry as FileSystemFileEntry).file(async (f) => res([{
              path: '/' + rel,
              mime: sniffType(entry.name),
              data: new Uint8Array(await f.arrayBuffer()),
            }]), () => res([])),
          ))
        }
      }
      readBatch()
    }, () => resolve([]))
    readBatch()
  })
}

async function selectSingleFile(f: File) {
  const data = new Uint8Array(await f.arrayBuffer())
  await selectEntries([{ path: '/' + f.name, mime: sniffType(f.name), data }], f.name, false)
}

async function selectFolderFiles(files: File[]) {
  const collected: DeployFile[] = []
  let root = ''
  for (const f of files) {
    // webkitRelativePath includes the picked folder name — strip it so paths
    // are bundle-root-relative, matching encode-w3fs.js's --dir behaviour.
    const parts = f.webkitRelativePath.split('/')
    root = parts[0]
    const rel = parts.slice(1).join('/')
    if (!rel || isSkippedPath(rel)) continue
    collected.push({ path: '/' + rel, mime: sniffType(f.name), data: new Uint8Array(await f.arrayBuffer()) })
  }
  if (collected.length === 0) return
  await selectEntries(collected, root, true)
}

async function selectEntries(files: DeployFile[], label: string, dir: boolean) {
  entries = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  isDirectory = dir
  selectionLabel = label
  await encodeSelection()
  renderSummary()
  renderPreview()
  stepSelect.classList.add('done')
  stepPreview.classList.remove('hidden')
  stepPreview.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---------------------------------------------------------------------------
// Step 2 — encode + preview
// ---------------------------------------------------------------------------

let rawSize = 0
let onchainSize = 0

async function encodeSelection() {
  if (isDirectory) {
    const res = await encodeBundle(entries)
    calldatas = res.chunks
    rawSize = res.rawSize
  } else {
    const e = entries[0]
    calldatas = await encodeSingleFile(e.mime, e.data)
    rawSize = e.data.length
  }
  onchainSize = calldatas.reduce((n, c) => n + c.length, 0)
}

function renderSummary() {
  $('sum-content').textContent = isDirectory
    ? `${selectionLabel}/ (folder)`
    : `${selectionLabel} — ${entries[0].mime}`
  $('sum-files-row').classList.toggle('hidden', !isDirectory)
  if (isDirectory) $('sum-files').textContent = `${entries.length} files`
  $('sum-raw').textContent = fmtBytes(rawSize)
  $('sum-onchain').textContent = `${fmtBytes(onchainSize)} calldata`
  $('sum-txs').textContent = String(calldatas.length)
  estimateCost()
}

async function estimateCost() {
  const costEl = $('sum-cost')
  costEl.textContent = '…'
  if (!chain) { costEl.textContent = '—'; return }
  const totalGas = calldatas.reduce((n, c) => n + txGasLimit(c), 0n)
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'eth-rpc', chainId: chain.chainId, method: 'eth_gasPrice', params: [],
    }) as { result?: string; error?: string }
    if (!resp?.result) throw new Error(resp?.error ?? 'no gas price')
    const wei = totalGas * BigInt(resp.result)
    costEl.textContent = `~${(Number(wei) / 1e18).toFixed(5)} ETH (${totalGas.toLocaleString()} gas)`
  } catch {
    costEl.textContent = `${totalGas.toLocaleString()} gas (gas price unavailable)`
  }
}

// The preview sandbox loads eagerly; wait for its message listener before posting.
const previewReady = new Promise<void>((resolve) =>
  previewFrame.addEventListener('load', () => resolve(), { once: true }),
)
function sendToPreview(html: string, assetMap: Record<string, string> = {}) {
  previewRaw.classList.add('hidden')
  previewFrame.classList.remove('hidden')
  previewReady.then(() =>
    previewFrame.contentWindow?.postMessage({ type: 'render', html, assetMap, chainId: chain?.chainId ?? 1 }, '*'),
  )
}
function showRawPreview(build: (host: HTMLElement) => void) {
  previewFrame.classList.add('hidden')
  previewRaw.classList.remove('hidden')
  previewRaw.innerHTML = ''
  build(previewRaw)
}

function renderPreview() {
  if (isDirectory) {
    const bundleFiles: BundleFile[] = entries.map(e => ({ path: e.path, mimeType: e.mime, data: e.data }))
    const entry = bundleFiles.find(f => f.path === '/index.html')
    if (entry) {
      const { html, assetMap } = buildWebsiteHtml(bundleFiles, entry)
      sendToPreview(html, assetMap)
    } else {
      // No index.html — visitors get a clickable file listing; preview the same.
      showFileListing()
    }
    return
  }
  previewFile(entries[0])
}

// Directory listing preview — rows link into each file, mirroring the listing
// the renderer builds for a bundle without an index.html.
function showFileListing() {
  showRawPreview((host) => {
    const h = document.createElement('p')
    h.textContent = 'No index.html — the page will show this file listing. Click a file to preview it:'
    const table = document.createElement('table')
    for (const f of entries) {
      const tr = document.createElement('tr')
      const tdPath = document.createElement('td')
      const a = document.createElement('a')
      a.textContent = f.path
      a.addEventListener('click', () => previewFile(f, true))
      tdPath.appendChild(a)
      const tdMime = document.createElement('td')
      tdMime.textContent = f.mime
      const tdSize = document.createElement('td')
      tdSize.textContent = `${f.data.length.toLocaleString()} B`
      tr.append(tdPath, tdMime, tdSize)
      table.appendChild(tr)
    }
    host.append(h, table)
  })
}

// Render one file the way the renderer would. `fromListing` adds a back link.
function previewFile(e: DeployFile, fromListing = false) {
  const ct = e.mime.toLowerCase().split(';')[0].trim()

  const raw = (build: (host: HTMLElement) => void) => showRawPreview((host) => {
    if (fromListing) {
      const back = document.createElement('a')
      back.className = 'back-link'
      back.textContent = '← back to listing'
      back.addEventListener('click', () => showFileListing())
      host.appendChild(back)
    }
    build(host)
  })

  // HTML/JS render in the sandbox — but a bundle's non-entry HTML is shown as a
  // download by the renderer, so only the top-level entry gets sandboxed here.
  if (!fromListing && ct.includes('html')) {
    sendToPreview(new TextDecoder().decode(e.data))
  } else if (!fromListing && ct.includes('javascript')) {
    sendToPreview(`<!DOCTYPE html><html><body><div id="root"></div><script type="module">${new TextDecoder().decode(e.data)}<\/script></body></html>`)
  } else if (ct.startsWith('image/')) {
    raw((host) => {
      const img = document.createElement('img')
      img.src = URL.createObjectURL(new Blob([e.data as Uint8Array<ArrayBuffer>], { type: ct }))
      host.appendChild(img)
    })
  } else if (ct === 'application/pdf') {
    raw((host) => {
      const frame = document.createElement('iframe')
      frame.src = URL.createObjectURL(new Blob([e.data as Uint8Array<ArrayBuffer>], { type: ct }))
      host.appendChild(frame)
    })
  } else if (ct.startsWith('text/') || ct.includes('html') || ct.includes('javascript') || ct === 'application/json') {
    raw((host) => {
      const pre = document.createElement('pre')
      pre.textContent = new TextDecoder().decode(e.data)
      host.appendChild(pre)
    })
  } else {
    raw((host) => {
      const p = document.createElement('p')
      p.textContent = `No preview for ${ct || 'unknown type'} — visitors get a download link (${e.data.length.toLocaleString()} bytes).`
      host.appendChild(p)
    })
  }
}

// The previewed website is fully interactive: reads go through the background's
// verified eth-rpc path (same as the renderer), and wallet actions go to the
// real wallet — connecting, signing and sending all work exactly as they will
// once deployed, so the preview can be clicked through end to end.
const CONNECT_METHODS = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])
const WALLET_METHODS = new Set([
  'eth_sendTransaction', 'eth_sendRawTransaction',
  'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
])

function notifyPreviewAccounts(accounts: unknown[]) {
  previewFrame.contentWindow?.postMessage(
    { type: 'wallet-event', method: 'accountsChanged', params: accounts }, '*',
  )
}

window.addEventListener('message', async (e) => {
  if (!e.data || e.source !== previewFrame.contentWindow) return
  if (e.data.type !== 'eth-request') return
  const { id, method, params } = e.data
  const reply = (result?: unknown, error?: string) =>
    previewFrame.contentWindow?.postMessage({ type: 'eth-response', id, result, error }, '*')

  // Answerable without a wallet — the URL's chain is authoritative.
  if (method === 'eth_chainId') { reply('0x' + (chain?.chainId ?? 1).toString(16)); return }
  if (method === 'eth_accounts') {
    // Ask the wallet, so a switch made in MetaMask reaches the previewed website.
    if (!account) { reply([]); return }
    const live = await refreshAccount()
    reply(live ? [live] : [])
    return
  }

  if (CONNECT_METHODS.has(method)) {
    if (!account) {
      const connected = await ensureWallet(msg => reply(undefined, msg))
      if (!connected) { reply(undefined, 'User rejected wallet selection'); return }
    }
    const resp = await walletRpc(method, params ?? [])
    if (!resp.error && Array.isArray(resp.result)) notifyPreviewAccounts(resp.result)
    reply(resp.result, resp.error)
    return
  }

  if (WALLET_METHODS.has(method) || method.startsWith('wallet_')) {
    if (!account) { reply(undefined, 'Not connected'); return }
    const resp = await walletRpc(method, params ?? [])
    reply(resp.result, resp.error)
    return
  }

  // All other eth_* reads → background (Helios-verified, same as the renderer).
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'eth-rpc', chainId: chain?.chainId ?? 1, method, params,
    }) as { result?: unknown; error?: string } | undefined
    reply(resp?.result, resp?.error ?? (resp ? undefined : 'no response'))
  } catch (err: any) {
    reply(undefined, err?.message ?? 'eth-rpc unavailable')
  }
})

$('change-selection').addEventListener('click', () => {
  stepPreview.classList.add('hidden')
  stepDeploy.classList.add('hidden')
  stepVerify.classList.add('hidden')
  stepName.classList.add('hidden')
  stepSelect.classList.remove('done')
  sendToPreview('')  // clear stale website
  entries = []
  calldatas = []
  coords = []
  nextTxIndex = 0
  stepSelect.scrollIntoView({ behavior: 'smooth' })
})

// ---------------------------------------------------------------------------
// Step 3 — connect wallet + send transactions
// ---------------------------------------------------------------------------

$('start-deploy').addEventListener('click', async () => {
  stepPreview.classList.add('done')
  stepDeploy.classList.remove('hidden')
  stepDeploy.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (!account) await showWalletPicker()
})

const WALLET_ICONS: Record<string, { file: string; style?: string }> = {
  'MetaMask':       { file: 'icons/metamask.png' },
  'MetaMask Flask': { file: 'icons/metamask.png' },
  'Frame':          { file: 'icons/frame.png', style: 'filter:invert(1)' },
}

function walletButton(w: { name: string; id: string }, onPick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'wallet-option'
  const icon = WALLET_ICONS[w.name]
  if (icon) {
    const img = document.createElement('img')
    img.src = chrome.runtime.getURL(icon.file)
    img.width = 22; img.height = 22
    if (icon.style) img.style.cssText = icon.style
    btn.appendChild(img)
  }
  btn.appendChild(document.createTextNode(w.name))
  btn.addEventListener('click', onPick)
  return btn
}

const NO_WALLET_HTML =
  'No wallet found. Install <a href="https://metamask.io/download/" target="_blank">MetaMask</a> ' +
  'or <a href="https://frame.sh" target="_blank">Frame</a>, then reopen this page.'

function listWallets(): Promise<Array<{ name: string; id: string }>> {
  return chrome.runtime.sendMessage({ type: 'list-wallets' }).catch(() => []) as
    Promise<Array<{ name: string; id: string }>>
}

// Step-3 inline picker: connects, then immediately starts the deployment.
async function showWalletPicker() {
  walletList.innerHTML = ''
  $('wallet-prompt').textContent = 'Detecting wallets…'
  const wallets = await listWallets()

  if (!wallets || wallets.length === 0) {
    $('wallet-prompt').innerHTML = NO_WALLET_HTML
    return
  }

  $('wallet-prompt').textContent = 'Connect the wallet that pays for the transactions:'
  for (const w of wallets) {
    walletList.appendChild(walletButton(w, async () => {
      showDeployError(null)
      if (!await connectAccount(w.id, w.name)) return
      if (!await ensureChain(showDeployError)) { retryDeploy.classList.remove('hidden'); return }
      await sendTransactions()
    }))
  }
}

// Modal picker: used wherever a wallet is needed outside the deploy step —
// the website preview and the standalone "link an existing deployment" path.
function pickWalletModal(): Promise<{ id: string; name: string } | null> {
  return new Promise(async (resolve) => {
    const close = (v: { id: string; name: string } | null) => {
      walletModal.classList.add('hidden')
      resolve(v)
    }
    walletModalList.innerHTML = ''
    walletModalTitle.textContent = 'Detecting wallets…'
    walletModal.classList.remove('hidden')
    $('wallet-modal-backdrop').onclick = () => close(null)

    const wallets = await listWallets()
    if (!wallets || wallets.length === 0) {
      walletModalTitle.textContent = 'No wallet found'
      const p = document.createElement('p')
      p.innerHTML = NO_WALLET_HTML
      walletModalList.appendChild(p)
      return
    }
    walletModalTitle.textContent = 'Select wallet'
    for (const w of wallets) {
      walletModalList.appendChild(walletButton(w, () => close({ id: w.id, name: w.name })))
    }
  })
}

function walletRpc(method: string, params: unknown[]): Promise<{ result?: any; error?: string }> {
  // Port (not sendMessage) keeps the service worker alive while the wallet's
  // approval popup is open — same pattern as renderer.ts.
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'eth-request' })
    port.postMessage({ method, params, walletId: selectedWalletId })
    port.onMessage.addListener((msg) => { port.disconnect(); resolve(msg) })
    port.onDisconnect.addListener(() => resolve({ error: 'Wallet disconnected' }))
  })
}

let walletName = 'wallet'

function showAccount() {
  walletConnect.classList.add('hidden')
  accountLine.classList.remove('hidden')
  $('account-addr').textContent = `${account} (${walletName})`
  // The name step is reachable without the deploy step (standalone linking), so
  // it carries its own copy of the account line.
  nameAccountLine.classList.remove('hidden')
  $('name-account-addr').textContent = account ?? '—'
}

async function connectAccount(walletId: string, name: string): Promise<boolean> {
  selectedWalletId = walletId
  walletName = name
  const resp = await walletRpc('eth_requestAccounts', [])
  if (resp.error || !Array.isArray(resp.result) || resp.result.length === 0) {
    selectedWalletId = null
    showDeployError(resp.error ?? 'Wallet returned no accounts')
    return false
  }
  account = resp.result[0] as string
  showAccount()
  return true
}

// Re-read the wallet's authorised account before anything that signs.
//
// Note this does NOT pick up an account switch made in MetaMask's UI: MetaMask
// authorises accounts per-origin, and selecting a different account in its
// account menu does not grant it to this origin — eth_accounts keeps returning
// the account permitted at connect time. Changing the signer requires
// re-requesting permissions, which is what switchAccount() below does. This
// call still matters for the cases eth_accounts *does* reflect: a locked
// wallet, revoked permissions, or a wallet (e.g. Frame) that does track the
// active account.
async function refreshAccount(): Promise<string | null> {
  const resp = await walletRpc('eth_accounts', [])
  const accounts = Array.isArray(resp.result) ? resp.result as string[] : []
  if (accounts.length === 0) {
    // Permissions revoked or wallet locked — force a fresh connect.
    account = null
    selectedWalletId = null
    accountLine.classList.add('hidden')
    nameAccountLine.classList.add('hidden')
    return null
  }
  if (accounts[0].toLowerCase() !== account?.toLowerCase()) {
    account = accounts[0]
    showAccount()
  }
  return account
}

// Ask the wallet to re-authorise: MetaMask opens its account picker, and the
// account chosen there becomes the permitted (and returned) one.
async function switchAccount(): Promise<string | null> {
  if (!selectedWalletId) return null
  switchAccountBtn.disabled = true
  nameSwitchBtn.disabled = true
  try {
    const resp = await walletRpc('wallet_requestPermissions', [{ eth_accounts: {} }])
    if (resp.error) {
      // Wallets without wallet_requestPermissions (Frame) — eth_requestAccounts
      // re-prompts there instead.
      const fallback = await walletRpc('eth_requestAccounts', [])
      if (Array.isArray(fallback.result) && fallback.result.length > 0) {
        account = fallback.result[0] as string
        showAccount()
        return account
      }
      return account
    }
    // The granted accounts come back in the permission's caveat; fall back to
    // eth_accounts if the wallet shapes the response differently.
    type Perm = { parentCapability?: string; caveats?: Array<{ type?: string; value?: unknown }> }
    const perms = (Array.isArray(resp.result) ? resp.result : []) as Perm[]
    const granted = perms.find(p => p.parentCapability === 'eth_accounts')
      ?.caveats?.find(c => c.type === 'restrictReturnedAccounts')?.value
    if (Array.isArray(granted) && granted.length > 0) {
      account = granted[0] as string
      showAccount()
      return account
    }
    return await refreshAccount()
  } finally {
    switchAccountBtn.disabled = false
    nameSwitchBtn.disabled = false
  }
}

switchAccountBtn.addEventListener('click', () => { switchAccount() })
// In standalone linking no wallet is connected yet — connect, then re-authorise.
nameSwitchBtn.addEventListener('click', async () => {
  if (!account) {
    const connected = await ensureWallet(msg => setNameStatus('fail', msg))
    if (!connected) return
  }
  await switchAccount()
})

// Connect on demand (modal) and put the wallet on the configured chain.
// Returns the connected account, or null if the user cancelled / it failed.
async function ensureWallet(onError: (msg: string) => void): Promise<string | null> {
  if (account) {
    return await ensureChain(onError) ? account : null
  }
  const picked = await pickWalletModal()
  if (!picked) return null
  if (!await connectAccount(picked.id, picked.name)) return null
  if (!await ensureChain(onError)) return null
  return account
}

async function ensureChain(onError: (msg: string) => void): Promise<boolean> {
  if (!chain) { onError('No chain configured'); return false }
  const want = '0x' + chain.chainId.toString(16)
  const cur = await walletRpc('eth_chainId', [])
  if (typeof cur.result === 'string' && cur.result.toLowerCase() === want) return true
  const sw = await walletRpc('wallet_switchEthereumChain', [{ chainId: want }])
  if (sw.error) {
    onError(`Wallet is on the wrong network and switching failed: ${sw.error}. ` +
      `Switch to ${chain.name} (chainId ${chain.chainId}) in the wallet, then retry.`)
    return false
  }
  return true
}

retryDeploy.addEventListener('click', async () => {
  retryDeploy.classList.add('hidden')
  showDeployError(null)
  if (!account) { await showWalletPicker(); return }
  if (!await ensureChain(showDeployError)) { retryDeploy.classList.remove('hidden'); return }
  await sendTransactions()
})

function showDeployError(msg: string | null) {
  deployError.classList.toggle('hidden', !msg)
  deployError.textContent = msg ?? ''
}

function txListItem(i: number): HTMLLIElement {
  let li = txList.children[i] as HTMLLIElement | undefined
  if (!li) {
    li = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `tx ${i + 1}/${calldatas.length} — ${fmtBytes(calldatas[i].length)}`
    const status = document.createElement('span')
    status.className = 'tx-status'
    li.append(label, status)
    txList.appendChild(li)
  }
  return li
}

function setTxStatus(i: number, text: string, cls?: 'ok' | 'fail') {
  const li = txListItem(i)
  li.classList.remove('ok', 'fail')
  if (cls) li.classList.add(cls)
  ;(li.querySelector('.tx-status') as HTMLElement).textContent = text
}

async function sendTransactions() {
  lockChainSelector()
  for (let i = 0; i < calldatas.length; i++) txListItem(i)

  for (; nextTxIndex < calldatas.length; nextTxIndex++) {
    const i = nextTxIndex
    const data = toHex(calldatas[i])
    const gas = '0x' + txGasLimit(calldatas[i]).toString(16)

    // Pick up an account switch made in the wallet since the last chunk.
    const from = await refreshAccount()
    if (!from) {
      setTxStatus(i, 'wallet disconnected', 'fail')
      showDeployError('The wallet reports no connected account — it may be locked or its ' +
        'permissions were revoked. Reconnect and retry; the remaining chunks resume from here.')
      walletConnect.classList.remove('hidden')
      await showWalletPicker()
      return
    }

    setTxStatus(i, 'approve in wallet…')
    const sent = await walletRpc('eth_sendTransaction', [{ from, to: W3FS_DEPOSIT, data, gas }])
    if (sent.error || typeof sent.result !== 'string') {
      setTxStatus(i, 'failed', 'fail')
      showDeployError(sent.error ?? 'eth_sendTransaction returned no hash')
      retryDeploy.classList.remove('hidden')
      return
    }
    const txHash = sent.result as string
    setTxStatus(i, `confirming ${txHash.slice(0, 10)}…`)

    const receipt = await waitForReceipt(txHash)
    if (!receipt) {
      setTxStatus(i, 'confirmation timeout', 'fail')
      showDeployError(`Transaction ${txHash} was not confirmed within 5 minutes. Retry resumes here once it lands.`)
      retryDeploy.classList.remove('hidden')
      return
    }
    if (receipt.status !== '0x1') {
      setTxStatus(i, 'reverted', 'fail')
      showDeployError(`Transaction ${txHash} reverted on-chain.`)
      retryDeploy.classList.remove('hidden')
      return
    }
    const blockNumber = parseInt(receipt.blockNumber, 16)
    const txIndex = parseInt(receipt.transactionIndex, 16)
    coords.push({ blockNumber, txIndex })
    setTxStatus(i, `✓ block ${blockNumber}, index ${txIndex}`, 'ok')
  }

  stepDeploy.classList.add('done')
  startVerification()
}

interface Receipt { blockNumber: string; transactionIndex: string; status: string }

async function waitForReceipt(txHash: string): Promise<Receipt | null> {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const resp = await walletRpc('eth_getTransactionReceipt', [txHash])
    if (resp.result?.blockNumber) return resp.result as Receipt
    await new Promise(r => setTimeout(r, 4_000))
  }
  return null
}

// ---------------------------------------------------------------------------
// Step 4 — verify through the normal two-phase resolve pipeline
// ---------------------------------------------------------------------------

let verifySettled = false

function startVerification() {
  if (!chain) return
  deployedUrl = formatWeb3URL({
    raw: '', chainId: chain.chainId, path: '/',
    target: { type: 'tx', refs: coords },
  })
  stepVerify.classList.remove('hidden')
  stepVerify.scrollIntoView({ behavior: 'smooth', block: 'start' })
  verifyWhenReady()
}

retryVerify.addEventListener('click', () => verifyWhenReady())

// Helios's head trails the chain tip by roughly one block plus its poll interval
// (measured: ~18-28s). We deploy and then verify after a single confirmation, so
// the block we just landed in does not exist yet as far as Helios is concerned:
// Mode 1 cannot fetch it and Mode 2's anchor is 'finalized' (~13 min back), so
// every mode fails and the user is told to "retry shortly" for a race they cannot
// see. Wait for Helios's verified head to actually reach the block first.
async function waitForHeliosHead(target: number): Promise<boolean> {
  const deadline = Date.now() + 4 * 60_000
  let last = 0
  while (Date.now() < deadline) {
    let head = 0
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'eth-rpc', chainId: chain!.chainId, method: 'eth_blockNumber', params: [],
      }) as { result?: string; error?: string } | undefined
      if (typeof resp?.result === 'string') head = parseInt(resp.result, 16)
    } catch { /* service worker restarting — try again */ }

    if (head >= target) return true

    if (head && head !== last) {
      last = head
      const behind = target - head
      setVerifyStatus('', `Waiting for the light client to reach block ${target} — ` +
        `Helios is at ${head} (${behind} block${behind === 1 ? '' : 's'} behind)…`, true)
    } else if (!head) {
      setVerifyStatus('', 'Waiting for the Helios light client to finish syncing…', true)
    }
    await new Promise(r => setTimeout(r, 4_000))
  }
  return false
}

async function verifyWhenReady() {
  retryVerify.classList.add('hidden')
  verifyDetail.classList.add('hidden')
  const target = Math.max(...coords.map(c => c.blockNumber))
  setVerifyStatus('', `Waiting for the light client to reach block ${target}…`, true)

  const caughtUp = await waitForHeliosHead(target)
  if (!caughtUp) {
    verifyFailed(`The light client did not reach block ${target} within 4 minutes.`)
    return
  }
  runVerification()
}

function setVerifyStatus(cls: '' | 'ok' | 'warn' | 'fail', html: string, spin = false) {
  verifyStatus.className = cls
  verifyStatus.innerHTML = (spin ? '<span class="spinner"></span> ' : '') + html
}

function runVerification() {
  verifySettled = false
  retryVerify.classList.add('hidden')
  verifyDetail.classList.add('hidden')
  setVerifyStatus('', `Verifying <code>${deployedUrl}</code> — fetching and proving the deployed bytes…`, true)

  const port = chrome.runtime.connect({ name: 'web3-resolve' })
  port.postMessage({ type: 'resolve', url: deployedUrl })

  const timeout = setTimeout(() => {
    if (!verifySettled) {
      verifySettled = true
      port.disconnect()
      verifyFailed('Verification timed out after 3 minutes. Helios may still be syncing — retry in a moment.')
    }
  }, 180_000)

  port.onMessage.addListener((msg: BgResponse) => {
    if (verifySettled) return
    if (msg.type === 'error') {
      verifySettled = true
      clearTimeout(timeout)
      port.disconnect()
      verifyFailed(msg.message)
    } else if (msg.type === 'content') {
      setVerifyStatus('', 'Content fetched back from the chain — running phase-2 verification…', true)
    } else if (msg.type === 'verification-update') {
      verifySettled = true
      clearTimeout(timeout)
      port.disconnect()
      const ok = msg.localMode || msg.portalVerified ||
        (msg.heliosBacked && msg.trieVerified) ||
        (msg.beaconVerified && msg.beaconHeliosAnchored)
      const mode =
        msg.localMode ? 'Mode 4 — local node (RPC trusted)' :
        msg.heliosBacked ? 'Mode 1 — recent block, Helios-verified' :
        msg.portalVerified ? 'Mode 3 — Portal-trusted' :
        msg.beaconVerified ? 'Mode 2 — historical block, beacon-verified' : 'no mode succeeded'
      if (ok) {
        setVerifyStatus('ok', `✓ Deployment verified (${mode})`)
        openLink.href = chrome.runtime.getURL('renderer.html') + '#' + deployedUrl
        openLink.textContent = `Open ${deployedUrl}`
        openLink.classList.remove('hidden')
        stepVerify.classList.add('done')
        stepName.classList.remove('hidden')
        stepName.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        verifyFailed(`Verification did not complete (${mode}). The block may be too fresh for Helios — retry shortly.`)
      }
    }
  })

  port.onDisconnect.addListener(() => {
    if (!verifySettled) {
      verifySettled = true
      clearTimeout(timeout)
      verifyFailed('Verification interrupted — the service worker restarted. Retry.')
    }
  })
}

function verifyFailed(msg: string) {
  setVerifyStatus('fail', '✗ ' + esc(msg))
  verifyDetail.classList.remove('hidden')
  verifyDetail.textContent = `Your content IS on-chain at ${deployedUrl} — only the proof step failed or is pending.`
  retryVerify.classList.remove('hidden')
  // Content is deployed regardless — let the user proceed to naming.
  openLink.href = chrome.runtime.getURL('renderer.html') + '#' + deployedUrl
  openLink.textContent = `Open ${deployedUrl}`
  openLink.classList.remove('hidden')
  stepName.classList.remove('hidden')
}

// ---------------------------------------------------------------------------
// Step 5 — link an owned .eth / .gwei / .wei name
// ---------------------------------------------------------------------------

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const GNS_NFT      = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'
const WNS_NFT      = '0x0000000000696760E15f265e828DB644A0c242EB'

const REGISTRY_IFACE = new Interface([
  'function resolver(bytes32 node) view returns (address)',
  'function owner(bytes32 node) view returns (address)',
])
const RESOLVER_IFACE = new Interface(['function setText(bytes32 node, string key, string value)'])
const NFT_IFACE = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isExpired(uint256 tokenId) view returns (bool)',
  'function setText(uint256 tokenId, string key, string value)',
])

async function ethCall(to: string, data: string): Promise<string> {
  const resp = await walletRpc('eth_call', [{ to, data }, 'latest'])
  if (resp.error) throw new Error(resp.error)
  return resp.result as string
}

// setText writes one or two fresh storage slots (~50-100k gas). We pass an
// explicit gas limit rather than letting the wallet estimate: MetaMask's
// internal estimation path fails for this call ("Cannot destructure property
// 'gasLimit' of null"), and eth_estimateGas also lets us catch an unauthorised
// signer before the approval popup opens.
const SETTEXT_FALLBACK_GAS = 250_000n

async function gasForRecordTx(from: string, to: string, data: string): Promise<string> {
  const est = await walletRpc('eth_estimateGas', [{ from, to, data }])
  if (est.error) {
    // Estimation reverts when the signer isn't authorised for the name — surface
    // that now instead of after a wallet approval that will fail on-chain.
    if (/revert|not authori[sz]ed|execution failed/i.test(est.error)) {
      throw new Error(
        `The connected account is not authorised to set records on this name ` +
        `(gas estimation reverted: ${est.error}).`,
      )
    }
    return '0x' + SETTEXT_FALLBACK_GAS.toString(16)
  }
  if (typeof est.result !== 'string') return '0x' + SETTEXT_FALLBACK_GAS.toString(16)
  // +30% headroom: resolvers that clear an old record use less gas than a fresh
  // write, and estimation against 'latest' can undershoot by a slot.
  const padded = (BigInt(est.result) * 130n) / 100n
  return '0x' + padded.toString(16)
}

function setNameStatus(cls: '' | 'ok' | 'fail', text: string, spin = false) {
  nameStatus.classList.remove('hidden', 'ok', 'fail')
  if (cls) nameStatus.classList.add(cls)
  nameStatus.innerHTML = (spin ? '<span class="spinner"></span> ' : '') + esc(text)
}

// Standalone entry point: skip deployment entirely and point a name at
// coordinates that are already on-chain (e.g. a deploy that succeeded but whose
// name link failed, or one published with the CLI scripts).
$('link-existing').addEventListener('click', (e) => {
  e.preventDefault()
  coordsBlock.classList.remove('hidden')
  stepName.classList.remove('hidden')
  stepName.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (coords.length > 0) coordsInput.value = coords.map(c => `${c.blockNumber}:${c.txIndex}`).join('+')
})

// Accepts "w3://11155111:900:3+901:4", "900:3+901:4", "900:3 901:4", or
// publish.js's JSON "[[900,3],[901,4]]".
function parseCoords(input: string): Array<{ blockNumber: number; txIndex: number }> {
  const raw = input.trim()
  if (!raw) throw new Error('Enter the deployment coordinates.')

  if (raw.startsWith('[')) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('Coordinates are not valid JSON.') }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a non-empty JSON array.')
    return parsed.map((pair, i) => {
      if (!Array.isArray(pair) || typeof pair[0] !== 'number' || typeof pair[1] !== 'number')
        throw new Error(`Expected [blockNumber, txIndex] at index ${i}.`)
      return { blockNumber: pair[0], txIndex: pair[1] }
    })
  }

  // Strip a w3:// prefix and any chainId prefix — the target chain comes from
  // settings, not from the pasted string, so a mismatched prefix is rejected.
  let body = raw.replace(/^w3:\/\//i, '').replace(/\/.*$/, '')
  const chainPrefix = /^(\d+):(?=\d+:\d+)/.exec(body)
  if (chainPrefix) {
    const id = parseInt(chainPrefix[1], 10)
    if (chain && id !== chain.chainId) {
      throw new Error(`Those coordinates are for chainId ${id}, but the deploy page targets ` +
        `${chain.name} (chainId ${chain.chainId}). Change the network in settings first.`)
    }
    body = body.slice(chainPrefix[0].length)
  }

  const parts = body.split(/[+\s,]+/).filter(Boolean)
  return parts.map((part) => {
    const m = /^(\d+):(\d+)$/.exec(part)
    if (!m) throw new Error(`Invalid coordinate "${part}" — expected block:txIndex.`)
    return { blockNumber: parseInt(m[1], 10), txIndex: parseInt(m[2], 10) }
  })
}

linkNameBtn.addEventListener('click', async () => {
  // Standalone mode: coordinates come from the input rather than a deployment.
  if (!coordsBlock.classList.contains('hidden')) {
    try {
      coords = parseCoords(coordsInput.value)
    } catch (err: any) {
      setNameStatus('fail', err?.message ?? String(err))
      return
    }
  }
  if (coords.length === 0) {
    setNameStatus('fail', 'No deployment coordinates — deploy first, or enter existing ones above.')
    return
  }
  if (!account) {
    const connected = await ensureWallet(msg => setNameStatus('fail', msg))
    if (!connected) { setNameStatus('fail', 'A connected wallet is required to write the record.'); return }
  }

  // Every call below (resolver lookup, ownerOf, setText) goes through the wallet,
  // so it lands on whatever chain the WALLET is on — not the chain we deployed to.
  // ensureChain only runs inside ensureWallet, which is skipped when an account is
  // already connected from the deploy step, so a wallet sitting on mainnet would
  // silently read mainnet ENS and write the record there while the coordinates
  // point at Sepolia. Force the deploy chain before touching the registry.
  if (!await ensureChain(msg => setNameStatus('fail', msg))) return

  let name: string
  try {
    name = ensNormalize(nameInput.value.trim())
  } catch {
    setNameStatus('fail', 'Invalid name.')
    return
  }
  if (!/\.(eth|gwei|wei)$/.test(name)) {
    setNameStatus('fail', 'Name must end in .eth, .gwei, or .wei')
    return
  }

  // Ownership is checked against — and the record written by — whichever account
  // the wallet has selected right now, not the one connected earlier.
  const signer = await refreshAccount()
  if (!signer) { setNameStatus('fail', 'A connected wallet is required to write the record.'); return }

  linkNameBtn.disabled = true
  try {
    const value = JSON.stringify(coords.map(c => [c.blockNumber, c.txIndex]))
    const node = namehash(name)
    const isGns = name.endsWith('.gwei')
    const isWns = name.endsWith('.wei')
    let to: string
    let data: string

    if (isWns) {
      if (chain?.chainId !== 1) {
        throw new Error('WNS (.wei) names are currently available on Ethereum mainnet only. Select Mainnet first.')
      }
      setNameStatus('', `Checking ownership of ${name}…`, true)
      const tokenId = BigInt(node)
      let owner: string
      try {
        const res = await ethCall(WNS_NFT, NFT_IFACE.encodeFunctionData('ownerOf', [tokenId]))
        owner = NFT_IFACE.decodeFunctionResult('ownerOf', res)[0] as string
      } catch {
        throw new Error(`"${name}" is not registered. Register it at wei.domains first.`)
      }
      if (owner.toLowerCase() !== signer.toLowerCase()) {
        throw new Error(`"${name}" is owned by ${owner}, not the authorised account ${signer}. ` +
          `Use "switch account" above to authorise the owning account.`)
      }
      const expRes = await ethCall(WNS_NFT, NFT_IFACE.encodeFunctionData('isExpired', [tokenId]))
      if (NFT_IFACE.decodeFunctionResult('isExpired', expRes)[0] === true) {
        throw new Error(`"${name}" is expired — renew it at wei.domains first.`)
      }
      to = WNS_NFT
      data = NFT_IFACE.encodeFunctionData('setText', [tokenId, 'w3', value])
    } else if (isGns) {
      setNameStatus('', `Checking ownership of ${name}…`, true)
      const tokenId = BigInt(node)
      let owner: string
      try {
        const res = await ethCall(GNS_NFT, NFT_IFACE.encodeFunctionData('ownerOf', [tokenId]))
        owner = NFT_IFACE.decodeFunctionResult('ownerOf', res)[0] as string
      } catch {
        throw new Error(`"${name}" is not registered. Register it at gwei.domains first.`)
      }
      if (owner.toLowerCase() !== signer.toLowerCase()) {
        throw new Error(`"${name}" is owned by ${owner}, not the authorised account ${signer}. ` +
          `Use "switch account" above to authorise the owning account.`)
      }
      const expRes = await ethCall(GNS_NFT, NFT_IFACE.encodeFunctionData('isExpired', [tokenId]))
      if (NFT_IFACE.decodeFunctionResult('isExpired', expRes)[0] === true) {
        throw new Error(`"${name}" is expired — renew it at gwei.domains first.`)
      }
      to = GNS_NFT
      data = NFT_IFACE.encodeFunctionData('setText', [tokenId, 'w3', value])
    } else {
      setNameStatus('', `Looking up resolver for ${name}…`, true)
      const resolverRes = await ethCall(ENS_REGISTRY, REGISTRY_IFACE.encodeFunctionData('resolver', [node]))
      const resolver = REGISTRY_IFACE.decodeFunctionResult('resolver', resolverRes)[0] as string
      if (/^0x0+$/.test(resolver)) {
        throw new Error(`No resolver set for ${name}. Set one at app.ens.domains first.`)
      }
      // Light ownership hint — wrapped/legacy names have other auth paths, so
      // this only warns; the resolver itself enforces authorisation on-chain.
      const ownerRes = await ethCall(ENS_REGISTRY, REGISTRY_IFACE.encodeFunctionData('owner', [node]))
      const owner = REGISTRY_IFACE.decodeFunctionResult('owner', ownerRes)[0] as string
      if (owner.toLowerCase() !== signer.toLowerCase()) {
        setNameStatus('', `Registry owner is ${owner} (wrapped name?) — the wallet will reject if unauthorised…`, true)
      }
      to = resolver
      data = RESOLVER_IFACE.encodeFunctionData('setText', [node, 'w3', value])
    }

    const gas = await gasForRecordTx(signer, to, data)

    setNameStatus('', `Setting "w3" record = ${value} — approve in wallet…`, true)
    const sent = await walletRpc('eth_sendTransaction', [{ from: signer, to, data, gas }])
    if (sent.error || typeof sent.result !== 'string') {
      throw new Error(sent.error ?? 'eth_sendTransaction returned no hash')
    }
    setNameStatus('', `Confirming ${(sent.result as string).slice(0, 10)}…`, true)
    const receipt = await waitForReceipt(sent.result as string)
    if (!receipt) throw new Error('Record transaction not confirmed within 5 minutes.')
    if (receipt.status !== '0x1') throw new Error('Record transaction reverted — is the connected account authorised for this name?')

    const nameUrl = formatWeb3URL({
      raw: '', chainId: chain!.chainId, path: '/', target: { type: 'ens', name },
    })
    setNameStatus('ok', `✓ Record set in block ${parseInt(receipt.blockNumber, 16)}.`)
    nameDone.classList.remove('hidden')
    // Standalone linking has no deploy step, so derive the coordinate URL from
    // whatever coords we linked (typed in or produced by this session's deploy).
    $('name-coords-url').textContent = deployedUrl || formatWeb3URL({
      raw: '', chainId: chain!.chainId, path: '/', target: { type: 'tx', refs: coords },
    })
    nameLink.href = chrome.runtime.getURL('renderer.html') + '#' + nameUrl
    nameLink.textContent = `Open ${nameUrl}`
    stepName.classList.add('done')
  } catch (err: any) {
    setNameStatus('fail', err?.message ?? String(err))
  } finally {
    linkNameBtn.disabled = false
  }
})

// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}
function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
