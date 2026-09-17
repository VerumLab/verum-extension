import { DEFAULT_CHAINS, DEFAULT_DEV_SETTINGS } from './types.js'
import type { ChainConfig, EraSource, StateSource, ForceMode, HistSource } from './types.js'

const chainsEl           = document.getElementById('chains') as HTMLDivElement
const toast              = document.getElementById('saved-toast') as HTMLDivElement
const urlPermBanner      = document.getElementById('url-permission-banner') as HTMLDivElement
const addBtn          = document.getElementById('add-chain-btn') as HTMLButtonElement
const addToggle       = document.getElementById('add-chain-toggle') as HTMLButtonElement
const addChainEl      = document.getElementById('add-chain') as HTMLDivElement
const newId           = document.getElementById('new-chain-id') as HTMLInputElement
const newName         = document.getElementById('new-chain-name') as HTMLInputElement
const defaultChainSel = document.getElementById('default-chain-select') as HTMLSelectElement
const clearCacheBtn   = document.getElementById('clear-cache-btn') as HTMLButtonElement
const cacheInfo       = document.getElementById('cache-info') as HTMLSpanElement

// "Helios reads" switch — ON means dApp runtime reads go through Helios (verified, slow);
// OFF means they're served from the fast RPC (trusted, fast — needed by read-heavy dApps).
// Backed by the session-scoped `trustedReads` flag (its inverse), so it resets to the safe
// verified default (Helios ON) on browser restart. Content is always Helios-verified at load.
const heliosReadsSwitch = document.getElementById('helios-reads') as HTMLInputElement
// Default is trusted RPC (Helios reads OFF) for max dApp compatibility — the switch is on
// only when the user has explicitly enabled Helios-verified reads (trustedReads === false).
chrome.storage.session.get('trustedReads').then(v => { heliosReadsSwitch.checked = v.trustedReads === false })
heliosReadsSwitch.addEventListener('change', () => {
  chrome.storage.session.set({ trustedReads: !heliosReadsSwitch.checked })
})

// The FAQ is deployed as calldata under extension.verum.gwei. Open it through the renderer
// so it goes through the normal verified w3:// path, not an HTTP mirror.
document.getElementById('faq-link')!.addEventListener('click', (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('renderer.html') + '#w3://extension.verum.gwei:1' })
})

async function updateCacheInfo() {
  const [local, sync, bytesInUse] = await Promise.all([
    chrome.storage.local.get(['dapp_proof_cache', 'era_bsr_cache']),
    chrome.storage.sync.get('chains'),
    chrome.storage.local.getBytesInUse(['dapp_proof_cache', 'era_bsr_cache']),
  ])
  const dapp_proof_cache = local.dapp_proof_cache as Record<string, unknown> | undefined
  const era_bsr_cache = local.era_bsr_cache as
    Record<number, { histSummaries?: string; effectiveSlot?: number }> | undefined
  const chainNames: Record<number, string> = {}
  for (const c of Object.values(sync.chains ?? {})) {
    const ch = c as { chainId: number; name: string }
    chainNames[ch.chainId] = ch.name
  }

  // Group dapp proofs by chainId
  const dappsPerChain: Record<number, number> = {}
  for (const proof of Object.values(dapp_proof_cache ?? {})) {
    const p = proof as { chainId?: number }
    const id = p.chainId ?? 0
    dappsPerChain[id] = (dappsPerChain[id] ?? 0) + 1
  }

  // Collect all chainIds across both caches
  const allChainIds = new Set<number>([
    ...Object.keys(dappsPerChain).map(Number),
    ...Object.keys(era_bsr_cache ?? {}).map(Number),
  ])

  const lines: string[] = []
  for (const chainId of [...allChainIds].sort((a, b) => a - b)) {
    const name = chainNames[chainId] ?? (chainId === 0 ? 'unknown chain' : `chain ${chainId}`)
    const parts: string[] = []

    const dapps = dappsPerChain[chainId]
    if (dapps) parts.push(`${dapps} dapp${dapps === 1 ? '' : 's'}`)

    const bsr = era_bsr_cache?.[chainId]
    if (bsr?.histSummaries) {
      const n = Math.floor(bsr.histSummaries.length * 3 / 4 / 64)
      if (n > 0) {
        const slot = bsr.effectiveSlot != null ? ` (state slot ${bsr.effectiveSlot})` : ''
        parts.push(`${n} historical summaries${slot}`)
      }
    }

    if (parts.length > 0) lines.push(`${name}: ${parts.join(', ')}`)
  }

  if (bytesInUse > 0) {
    const kb = (bytesInUse / 1024).toFixed(1)
    lines.push(`${kb} KB total`)
  }

  cacheInfo.textContent = lines.length > 0 ? lines.join('\n') : 'No cache'
}

clearCacheBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['dapp_proof_cache', 'era_bsr_cache'])
  updateCacheInfo()
})

updateCacheInfo()

// Developer mode ---------------------------------------------------------------
// Pins the Mode 2 sources. Stored in sync alongside chains/defaultChain; the
// background reads them per resolve, so changes apply to the next navigation
// without reloading the extension.

const devModeCb   = document.getElementById('dev-mode') as HTMLInputElement
const devOptions  = document.getElementById('dev-options') as HTMLDivElement
const forceModeEl = document.getElementById('force-mode') as HTMLSelectElement
const eraSourceEl = document.getElementById('era-source') as HTMLSelectElement
const stateSrcEl  = document.getElementById('state-source') as HTMLSelectElement
const histSrcEl   = document.getElementById('hist-source') as HTMLSelectElement

async function loadDevSettings() {
  const s = await chrome.storage.sync.get(['devMode', 'forceMode', 'eraSource', 'stateSource', 'histSource'])
  devModeCb.checked  = (s.devMode as boolean | undefined) ?? DEFAULT_DEV_SETTINGS.devMode
  forceModeEl.value  = (s.forceMode as string | undefined) ?? DEFAULT_DEV_SETTINGS.forceMode
  eraSourceEl.value  = (s.eraSource as string | undefined) ?? DEFAULT_DEV_SETTINGS.eraSource
  stateSrcEl.value   = (s.stateSource as string | undefined) ?? DEFAULT_DEV_SETTINGS.stateSource
  histSrcEl.value    = (s.histSource as string | undefined) ?? DEFAULT_DEV_SETTINGS.histSource
  devOptions.classList.toggle('hidden', !devModeCb.checked)
}

function saveDevSettings() {
  devOptions.classList.toggle('hidden', !devModeCb.checked)
  chrome.storage.sync.set({
    devMode: devModeCb.checked,
    forceMode: forceModeEl.value as ForceMode,
    eraSource: eraSourceEl.value as EraSource,
    stateSource: stateSrcEl.value as StateSource,
    histSource: histSrcEl.value as HistSource,
  }).then(showToast)
}

devModeCb.addEventListener('change', saveDevSettings)
forceModeEl.addEventListener('change', saveDevSettings)
eraSourceEl.addEventListener('change', saveDevSettings)
stateSrcEl.addEventListener('change', saveDevSettings)
histSrcEl.addEventListener('change', saveDevSettings)

loadDevSettings()

// Per-domain permission banners -----------------------------------------------

function urlToOriginPattern(url: string): string | null {
  try {
    const u = new URL(url.trim())
    if (!u.hostname || u.hostname === 'localhost') return null
    if (/^[\d.]+$/.test(u.hostname)) return null  // IP address — skip
    const parts = u.hostname.split('.')
    if (parts.length < 2) return null
    return `*://*.${parts.slice(-2).join('.')}/*`
  } catch { return null }
}

// Collect every unique origin pattern from all custom chain URLs.
function allConfiguredPatterns(stored: Record<number, ChainConfig>): Set<string> {
  const patterns = new Set<string>()
  for (const chain of Object.values(stored)) {
    for (const url of [...chain.rpcs, ...chain.consensusRpcs, ...(chain.checkpointUrls ?? [])]) {
      const p = urlToOriginPattern(url)
      if (p) patterns.add(p)
    }
  }
  return patterns
}

async function updatePermissionBanners() {
  const stored = await chrome.storage.sync.get('chains')
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const patterns = allConfiguredPatterns(chains)

  // Remove banners for patterns that are now gone or already granted.
  for (const el of [...urlPermBanner.parentElement!.querySelectorAll<HTMLElement>('.domain-perm-banner')]) {
    const pattern = el.dataset.pattern!
    if (!patterns.has(pattern) || await chrome.permissions.contains({ origins: [pattern] })) {
      el.remove()
    }
  }

  // Add a banner for each pattern that isn't permitted yet.
  for (const pattern of patterns) {
    const granted = await chrome.permissions.contains({ origins: [pattern] })
    if (granted) continue
    if (urlPermBanner.parentElement!.querySelector(`[data-pattern="${CSS.escape(pattern)}"]`)) continue

    const domain = pattern.replace('*://*.', '').replace('/*', '')
    const banner = document.createElement('div')
    banner.className = 'domain-perm-banner'
    banner.dataset.pattern = pattern
    banner.innerHTML = `<span>Custom RPC requires access to <strong>${domain}</strong></span><button>Grant access</button>`
    banner.querySelector('button')!.addEventListener('click', () => {
      chrome.permissions.request({ origins: [pattern] }).then(ok => {
        if (ok) banner.remove()
      }).catch(() => {})
    })
    urlPermBanner.insertAdjacentElement('afterend', banner)
  }
}

updatePermissionBanners()

addToggle.addEventListener('click', () => {
  addChainEl.classList.toggle('hidden')
  addToggle.textContent = addChainEl.classList.contains('hidden') ? '+' : '×'
})

let chains: Record<number, ChainConfig> = {}

async function load() {
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const defaultChain = (stored.defaultChain as number | undefined) ?? 1
  renderDefaultChainSelector(defaultChain)
  render()
}

function renderDefaultChainSelector(selected: number) {
  defaultChainSel.innerHTML = ''
  for (const chain of Object.values(chains)) {
    const opt = document.createElement('option')
    opt.value = String(chain.chainId)
    opt.textContent = `${chain.name} (${chain.chainId})`
    if (chain.chainId === selected) opt.selected = true
    defaultChainSel.appendChild(opt)
  }
}

defaultChainSel.addEventListener('change', () => {
  chrome.storage.sync.set({ defaultChain: parseInt(defaultChainSel.value) }).then(showToast)
  render()
})

function render() {
  chainsEl.innerHTML = ''
  const selectedId = parseInt(defaultChainSel.value)
  const chain = chains[selectedId]
  if (chain) chainsEl.appendChild(buildCard(chain))
}

function buildCard(chain: ChainConfig): HTMLElement {
  const card = document.createElement('div')
  card.className = 'chain-card'

  const hasDefaults = !!DEFAULT_CHAINS[chain.chainId]
  if (chain.localMode) card.classList.add('local-mode')
  card.innerHTML = `
    <div class="chain-header">
      <span class="chain-id">chainId ${chain.chainId}</span>
      <span class="chain-name">${chain.name}</span>
      ${hasDefaults ? '<button class="reset-chain" title="Reset RPCs to defaults">↺ Reset</button>' : ''}
      ${!hasDefaults ? '<button class="delete-chain" title="Remove chain">✕</button>' : ''}
    </div>
    <div class="local-mode-row">
      <label class="local-mode-label">
        <span class="toggle-track">
          <input type="checkbox" class="local-mode-toggle" ${chain.localMode ? 'checked' : ''} />
          <span class="toggle-thumb"></span>
        </span>
        Local node mode <span class="rpc-hint">(only activate when using trusted local execution and consensus nodes)</span>
      </label>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Consensus RPCs (beacon API)</div>
      <div class="consensus-list"></div>
      <button class="add-rpc" data-type="consensus">+ Add consensus RPC</button>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Execution RPCs <span class="rpc-hint exec-hint">(default batch size 200)</span><span class="rpc-hint exec-hint-local" style="display:none">(only first RPC used — batch fixed at 1000)</span></div>
      <div class="execution-list"></div>
      <button class="add-rpc" data-type="execution">+ Add execution RPC</button>
    </div>
    <div class="rpc-group checkpoint-group">
      <div class="rpc-label">Checkpoint sync URLs <span class="rpc-hint">(optional — fast current BeaconState download)</span></div>
      <div class="checkpoint-list"></div>
      <button class="add-rpc" data-type="checkpoint">+ Add checkpoint URL</button>
    </div>
    <div class="rpc-group era-group">
      <div class="rpc-label">Era file URLs <span class="rpc-hint">(optional — fast historic era BeaconBlockRoots download)</span></div>
      <div class="era-list"></div>
      <button class="add-rpc" data-type="era">+ Add era file URL</button>
    </div>
    <div class="rpc-group parquet-group">
      <div class="rpc-label">Parquet base URLs <span class="rpc-hint">(optional — fast historic era BeaconBlockRoots download)</span></div>
      <div class="parquet-list"></div>
      <button class="add-rpc" data-type="parquet">+ Add parquet URL</button>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Portal Network node <span class="rpc-hint">(optional — local data download)</span></div>
      <input class="portal-rpc" type="url" value="${chain.portalRpc ?? ''}" placeholder="http://localhost:8545" />
    </div>
  `

  const consensusList  = card.querySelector('.consensus-list')  as HTMLDivElement
  const executionList  = card.querySelector('.execution-list')  as HTMLDivElement
  const checkpointList = card.querySelector('.checkpoint-list') as HTMLDivElement
  const eraList        = card.querySelector('.era-list')        as HTMLDivElement
  const parquetList    = card.querySelector('.parquet-list')    as HTMLDivElement

  chain.consensusRpcs.forEach((url) => consensusList.appendChild(rpcRow(url)))
  chain.rpcs.forEach((url) => executionList.appendChild(execRpcRow(url, chain.rpcBatchSizes?.[url])))
  ;(chain.checkpointUrls ?? []).forEach((url) => checkpointList.appendChild(rpcRow(url)))
  ;(chain.eraFileUrls ?? DEFAULT_CHAINS[chain.chainId]?.eraFileUrls ?? []).forEach((url) => eraList.appendChild(rpcRow(url)))
  ;(chain.parquetUrls ?? DEFAULT_CHAINS[chain.chainId]?.parquetUrls ?? []).forEach((url) => parquetList.appendChild(rpcRow(url)))

  card.querySelector('.reset-chain')?.addEventListener('click', () => {
    const defaults = DEFAULT_CHAINS[chain.chainId]
    if (!defaults) return
    chains[chain.chainId] = {
      ...chains[chain.chainId],
      consensusRpcs: [...defaults.consensusRpcs],
      rpcs: [...defaults.rpcs],
      rpcBatchSizes: defaults.rpcBatchSizes ? { ...defaults.rpcBatchSizes } : undefined,
      checkpointUrls: defaults.checkpointUrls ? [...defaults.checkpointUrls] : undefined,
      eraFileUrls: defaults.eraFileUrls ? [...defaults.eraFileUrls] : undefined,
      parquetUrls: defaults.parquetUrls ? [...defaults.parquetUrls] : undefined,
    }
    save()
  })

  card.querySelector('.delete-chain')?.addEventListener('click', () => {
    delete chains[chain.chainId]
    save()
  })

  card.querySelectorAll<HTMLButtonElement>('.add-rpc').forEach((btn) => {
    btn.addEventListener('click', () => {
      let list: HTMLDivElement
      let row: HTMLElement
      if (btn.dataset.type === 'execution') {
        list = executionList; row = execRpcRow('')
      } else if (btn.dataset.type === 'checkpoint') {
        list = checkpointList; row = rpcRow('')
      } else if (btn.dataset.type === 'era') {
        list = eraList; row = rpcRow('')
      } else if (btn.dataset.type === 'parquet') {
        list = parquetList; row = rpcRow('')
      } else {
        list = consensusList; row = rpcRow('')
      }
      list.appendChild(row)
      ;(list.lastElementChild?.querySelector('input[type=url]') as HTMLInputElement)?.focus()
    })
  })

  // Sync changes back to chains on input
  const portalInput      = card.querySelector('.portal-rpc') as HTMLInputElement
  const localModeToggle  = card.querySelector('.local-mode-toggle') as HTMLInputElement
  const execHintNormal   = card.querySelector('.exec-hint') as HTMLElement
  const execHintLocal    = card.querySelector('.exec-hint-local') as HTMLElement

  function applyLocalMode(local: boolean) {
    card.classList.toggle('local-mode', local)
    execHintNormal.style.display = local ? 'none' : ''
    execHintLocal.style.display  = local ? '' : 'none'
  }
  applyLocalMode(!!chain.localMode)

  // Toggling local mode swaps the ACTIVE RPC set (what verification uses) between the
  // public RPCs and localhost, auto-filling localhost defaults the first time. The set
  // being left is stashed in savedRpcs/savedConsensusRpcs, so each set is independently
  // editable — editing the localhost RPCs never changes the saved public ones.
  const LOCAL_EXEC = 'http://localhost:8545'
  const LOCAL_CONSENSUS = 'http://localhost:5052'
  localModeToggle.addEventListener('change', () => {
    const on = localModeToggle.checked
    const curExec = rpcValues(executionList)
    const curCons = rpcValues(consensusList)
    // Switch TO the previously-saved set for the target mode, or sensible defaults.
    const nextExec = chain.savedRpcs?.length ? chain.savedRpcs
      : on ? [LOCAL_EXEC] : (DEFAULT_CHAINS[chain.chainId]?.rpcs ?? [])
    const nextCons = chain.savedConsensusRpcs?.length ? chain.savedConsensusRpcs
      : on ? [LOCAL_CONSENSUS] : (DEFAULT_CHAINS[chain.chainId]?.consensusRpcs ?? [])
    // Preserve the set we're leaving as the inactive set.
    chain.savedRpcs = curExec
    chain.savedConsensusRpcs = curCons
    executionList.innerHTML = ''
    nextExec.forEach((u) => executionList.appendChild(execRpcRow(u, chain.rpcBatchSizes?.[u])))
    consensusList.innerHTML = ''
    nextCons.forEach((u) => consensusList.appendChild(rpcRow(u)))
    applyLocalMode(on)
    syncCard()
  })

  function syncCard() {
    const portalVal  = portalInput.value.trim()
    const local      = localModeToggle.checked
    const execUrls   = rpcValues(executionList)
    const batchSizes = execBatchSizes(executionList)
    const cpUrls      = rpcValues(checkpointList)
    const eraUrls     = rpcValues(eraList)
    const parquetUrls = rpcValues(parquetList)
    chains[chain.chainId] = {
      ...chain,
      localMode: local || undefined,
      consensusRpcs: rpcValues(consensusList),
      rpcs: execUrls,
      ...(Object.keys(batchSizes).length > 0 ? { rpcBatchSizes: batchSizes } : { rpcBatchSizes: undefined }),
      ...(cpUrls.length > 0 ? { checkpointUrls: cpUrls } : { checkpointUrls: undefined }),
      ...(eraUrls.length > 0 ? { eraFileUrls: eraUrls } : { eraFileUrls: undefined }),
      ...(parquetUrls.length > 0 ? { parquetUrls } : { parquetUrls: undefined }),
      ...(portalVal ? { portalRpc: portalVal } : { portalRpc: undefined }),
    }
    saveQuiet()
  }

  enableDragReorder(consensusList, syncCard)
  enableDragReorder(executionList, syncCard)
  enableDragReorder(checkpointList, syncCard)
  enableDragReorder(eraList, syncCard)
  enableDragReorder(parquetList, syncCard)

  card.addEventListener('change', syncCard)
  card.addEventListener('input', debounce(syncCard, 600))

  return card
}

function rpcRow(url: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rpc-row'
  row.innerHTML = `
    <span class="drag-handle">⠿</span>
    <input type="url" value="${url}" placeholder="https://…" />
    <button title="Remove">✕</button>
  `
  row.querySelector('button')!.addEventListener('click', () => {
    const parent = row.parentElement
    row.remove()
    parent?.dispatchEvent(new Event('change', { bubbles: true }))
  })
  row.addEventListener('mousedown', (e) => {
    row.draggable = (row.querySelector('.drag-handle') as HTMLElement).contains(e.target as Node)
  })
  return row
}

function execRpcRow(url: string, batchSize?: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rpc-row'
  row.innerHTML = `
    <span class="drag-handle">⠿</span>
    <input type="url" value="${url}" placeholder="https://…" />
    <input type="number" class="batch-size" value="${batchSize ?? ''}" min="1" max="10000" placeholder="batch" title="Max JSON-RPC batch size for this endpoint" />
    <button title="Remove">✕</button>
  `
  row.querySelector('button')!.addEventListener('click', () => {
    const parent = row.parentElement
    row.remove()
    parent?.dispatchEvent(new Event('change', { bubbles: true }))
  })
  row.addEventListener('mousedown', (e) => {
    row.draggable = (row.querySelector('.drag-handle') as HTMLElement).contains(e.target as Node)
  })
  return row
}

function execBatchSizes(container: HTMLElement): Record<string, number> {
  const result: Record<string, number> = {}
  container.querySelectorAll<HTMLElement>('.rpc-row').forEach(row => {
    const url = row.querySelector<HTMLInputElement>('input[type=url]')?.value.trim()
    const val = parseInt(row.querySelector<HTMLInputElement>('.batch-size')?.value ?? '')
    if (url && val > 0) result[url] = val
  })
  return result
}

function enableDragReorder(list: HTMLElement, onChange: () => void) {
  let dragging: HTMLElement | null = null

  list.addEventListener('dragstart', (e) => {
    dragging = (e.target as HTMLElement).closest('.rpc-row') as HTMLElement | null
    setTimeout(() => dragging?.classList.add('dragging'), 0)
  })

  list.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging')
    dragging = null
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
  })

  list.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!dragging) return
    const target = (e.target as HTMLElement).closest<HTMLElement>('.rpc-row')
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
    if (!target || target === dragging) return
    const { top, height } = target.getBoundingClientRect()
    target.classList.add(e.clientY < top + height / 2 ? 'drop-above' : 'drop-below')
  })

  list.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!dragging) return
    const above = list.querySelector('.drop-above')
    const below = list.querySelector('.drop-below')
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
    if (above) list.insertBefore(dragging, above)
    else if (below) below.after(dragging)
    onChange()
  })
}

function rpcValues(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type=url]'))
    .map((i) => i.value.trim())
    .filter(Boolean)
}

addBtn.addEventListener('click', () => {
  const id = parseInt(newId.value)
  const name = newName.value.trim()
  if (!id || !name) return
  newId.value = ''
  newName.value = ''
  addChainEl.classList.add('hidden')
  addToggle.textContent = '+'
  if (chains[id]) {
    defaultChainSel.value = String(id)
    render()
    return
  }
  chains[id] = { chainId: id, name, consensusRpcs: [], rpcs: [] }
  save(id)
})

// Save + re-render — use for structural changes (add/delete chain, reset, drag-reorder)
function save(selectChainId?: number) {
  chrome.storage.sync.set({ chains }).then(async () => {
    const stored = await chrome.storage.sync.get('defaultChain')
    renderDefaultChainSelector((stored.defaultChain as number | undefined) ?? 1)
    if (selectChainId !== undefined) defaultChainSel.value = String(selectChainId)
    render()
    showToast()
  })
}

// Save only — use while the user is typing to avoid destroying the focused input
function saveQuiet() {
  chrome.storage.sync.set({ chains }).then(() => { showToast(); updatePermissionBanners() })
}

let toastTimer: ReturnType<typeof setTimeout>
function showToast() {
  toast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000)
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }) as T
}

load()
