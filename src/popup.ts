import { copyButton, selectable, selectingText } from './lib/ui/copy-button.js'
import { AGREEMENT_VERSION } from './types.js'
import { parseWeb3URL } from './lib/w3/url-parser.js'
import { checkpointInfoKey, checkpointSourceLines, checkpointSourceRows, checkpointRecheckText, checkpointCheckState, markCheckpointChecked, CHECK_HINT, type CheckpointInfo } from './lib/verify/checkpoint-info.js'

// Terms gate: until the user has accepted, clicking the extension icon just sends them
// to the onboarding/accept page — the app UI is never shown. Kept hidden until the check
// resolves so accepted users don't see a flash and unaccepted users see nothing.
document.documentElement.style.visibility = 'hidden'
void (async () => {
  const { agreement } = await chrome.storage.local.get('agreement') as { agreement?: { accepted?: boolean; version?: number } }
  if (!agreement?.accepted || (agreement.version ?? 0) < AGREEMENT_VERSION) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })
    window.close()
    return
  }
  document.documentElement.style.visibility = ''
})()

const idle    = document.getElementById('idle') as HTMLDivElement
const proof   = document.getElementById('proof') as HTMLDivElement
const verdict = document.getElementById('verdict') as HTMLDivElement
const navInput = document.getElementById('nav-input') as HTMLInputElement
const navGo    = document.getElementById('nav-go') as HTMLButtonElement

function navigate() {
  const raw = navInput.value.trim()
  if (!raw) return
  const url = raw.startsWith('w3://') ? raw : `w3://${raw}`
  const rendererUrl = chrome.runtime.getURL('renderer.html') + '#' + url
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.update(tab.id, { url: rendererUrl })
    window.close()
  })
}

navGo.addEventListener('click', navigate)
navInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate() })

document.getElementById('settings-btn')!.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })
})

document.getElementById('deploy-btn')!.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('deploy.html') })
})

// Re-render when background updates the proof (e.g. Helios finishes verifying)
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return
  const watchKey = `proof_${tab.id}`
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && checkpointKey && checkpointKey in changes) {
      renderCheckpoint(changes[checkpointKey].newValue as CheckpointInfo | undefined)
    }
    if (area === 'session' && watchKey in changes) {
      const data = changes[watchKey].newValue
      if (data) showProof(data)
      else showIdle()
    }
  })
})

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) { showIdle(); return }

  const key = `proof_${tab.id}`
  const stored = await chrome.storage.session.get(key)
  const data = stored[key]
  if (!data) { showIdle(); return }

  showProof(data)
}

// Light-client checkpoint, under the verdict: the hash Helios started from (so it can be compared by hand), and on
// click its epoch and how many independent sources agree on it.
let checkpointKey: string | null = null
async function showCheckpoint(url: string | undefined, localMode: boolean) {
  const box = document.getElementById('verdict-checkpoint')!
  if (!url || localMode) { box.classList.add('hidden'); checkpointKey = null; return }
  let chainId: number
  try {
    const { defaultChain } = await chrome.storage.sync.get('defaultChain')
    chainId = parseWeb3URL(url, (defaultChain as number | undefined) ?? 1).chainId
  } catch { box.classList.add('hidden'); return }
  checkpointKey = checkpointInfoKey(chainId)
  const info = (await chrome.storage.local.get(checkpointKey))[checkpointKey] as CheckpointInfo | undefined
  renderCheckpoint(info)
}

// A verification rests on the light client's checkpoint. While that checkpoint still needs the user's confirmation,
// a successful verdict is held back ("waiting"); it comes back as soon as the checkpoint is confirmed or chosen.
let lastProof: any = null
let verdictHeld = false
function holdVerdict(hold: boolean) {
  if (hold && /\b(verified|beacon|portal)\b/.test(verdict.className)) {
    verdict.className = 'unverified'
    document.getElementById('verdict-icon')!.textContent = '⏸'
    document.getElementById('verdict-text')!.textContent = 'Waiting for checkpoint confirmation'
    verdictHeld = true
  } else if (!hold && verdictHeld) {
    verdictHeld = false
    if (lastProof) showProof(lastProof)
  }
}

function renderCheckpoint(info: CheckpointInfo | undefined) {
  const box = document.getElementById('verdict-checkpoint')!
  if (!info?.root) { box.classList.add('hidden'); holdVerdict(false); return }
  const hash = document.getElementById('cp-hash')!
  hash.textContent = info.root
  // Copy button next to the hash (replaced on every render).
  document.querySelector('#cp-hashrow .copy-btn')?.remove()
  document.getElementById('cp-hashrow')!.append(copyButton(info.root, 'checkpoint hash'))
  const state = checkpointCheckState(info)
  hash.classList.toggle('cp-hash-checked', state !== 'needs-check')   // green once confirmed by the sources or checked by the user
  holdVerdict(state === 'needs-check')
  shownCheckpoint = { chainId: info.chainId, root: info.root }
  // Tell the user this hash is theirs to check, until they have.
  const askText = document.getElementById('cp-ask-text')!
  const confirm = document.getElementById('cp-confirm')!
  clearInterval(recheckTimer)
  // Confirmed by the sources: no line (the agreement in the dropdown says enough).
  document.getElementById('cp-ask')!.classList.toggle('hidden', state === 'confirmed')
  if (state !== 'needs-check') {
    // The green hash says it is confirmed; this counts down to the next checkpoint, which needs a new check.
    const tick = () => { askText.textContent = checkpointRecheckText(info) }
    tick()
    recheckTimer = setInterval(tick, 1000)
    askText.className = 'cp-recheck'
    confirm.classList.add('hidden')
  } else {
    askText.textContent = 'Check this hash yourself'
    askText.className = 'cp-todo'
    confirm.classList.remove('hidden')
  }
  askText.title = CHECK_HINT
  const ok = info.sources.filter(s => s.status === 'match').length
  const differ = info.sources.filter(s => s.status === 'mismatch').length
  const epochRow = document.getElementById('cp-epoch')!
  if (info.epoch !== null && info.slot !== null) {
    epochRow.replaceChildren('Epoch ', selectable(String(info.epoch)), copyButton(String(info.epoch), 'epoch'),
      ' · slot ', selectable(String(info.slot)), copyButton(String(info.slot), 'slot'))
  } else {
    epochRow.textContent = 'Epoch unknown'
  }
  const agree = document.getElementById('cp-agree')!
  agree.textContent = info.problem ?? `${ok}/${info.sources.length} agree${differ ? ` · ${differ} different` : ''}`
  agree.classList.toggle('cp-bad', info.verdict === 'disagree')
  agree.title = checkpointSourceLines(info).join('\n')
  // One row per source that reports a different hash, with what it reported.
  const drop = document.getElementById('cp-drop')!
  drop.querySelectorAll('.cp-reason').forEach(el => el.remove())
  for (const r of checkpointSourceRows(info)) {
    if (r.status !== 'mismatch') continue
    const row = document.createElement('div')
    row.className = 'cp-reason cp-bad'
    const who = document.createElement('span'); who.textContent = r.left
    const what = document.createElement('span'); what.className = 'cp-reason-what'; what.textContent = r.right
    row.append(who, what)
    drop.appendChild(row)
  }
  box.classList.remove('hidden')
}

let shownCheckpoint: { chainId: number; root: string } | null = null
let recheckTimer: ReturnType<typeof setInterval> | undefined
document.getElementById('cp-confirm')!.addEventListener('click', () => {
  if (shownCheckpoint) void markCheckpointChecked(shownCheckpoint.chainId, shownCheckpoint.root)
})

// The hash is selectable text, and a plain click on it opens/closes the details.
const toggleCheckpointDetails = () => { if (!selectingText()) document.getElementById('cp-drop')!.classList.toggle('hidden') }
document.getElementById('cp-hash')!.addEventListener('click', toggleCheckpointDetails)
document.getElementById('cp-hash')!.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('cp-drop')!.classList.toggle('hidden') }
})

function showIdle() {
  // No active w3:// page → show only the URL bar + footer (settings/deploy).
  idle.classList.add('hidden')
  proof.classList.add('hidden')
}

function showProof(d: any) {
  lastProof = d
  if (d.url) navInput.value = d.url.replace('w3://', '')
  void showCheckpoint(d.url, !!d.localMode)
  idle.classList.add('hidden')
  proof.classList.remove('hidden')

  const pending = d.pending === true
  const beaconTrusted = d.beaconVerified && d.beaconHeliosAnchored
  // Contract-served (ERC-5219/8244) pages have a contract address instead of a tx
  // record. They reuse ensVerified for the Helios byte-compare of the served body
  // and, when reached through a dotted name, its name-to-contract resolution.
  const contractServed = typeof d.contractAddress === 'string'
  // Any dotted name target (myapp.eth, myapp.gwei, …), whether it resolves to
  // calldata or a content-serving contract. Block:txIndex and raw contract refs
  // have no dots.
  const isEns = typeof d.url === 'string' && /(?:w3|portal):\/\/(?:\d+:)?[^/:]*\.[^/:]+/.test(d.url)
  // Helios failed to load/sync: reported as an error, not as an inconclusive check.
  const heliosErr = typeof d.heliosError === 'string' && d.heliosError !== ''
  const ensBlocked = isEns && d.ensVerified !== true && !pending && !d.localMode
  const contractBlocked = contractServed && d.ensVerified !== true && !pending && !d.localMode
  const cls = d.localMode ? 'verified' : ensBlocked || contractBlocked ? 'unverified' : d.portalVerified ? 'portal' : d.heliosBacked ? 'verified' : beaconTrusted ? 'beacon' : pending ? 'pending' : 'unverified'
  verdict.className = cls
  const fullyVerified = !pending && !ensBlocked && !contractBlocked &&
    (d.localMode || d.portalVerified || d.heliosBacked || beaconTrusted)

  // Unified badge: one ✓ for every fully-verified path (Helios read, beacon proof,
  // Portal, local), ⚠️ for blocked/unverified, ⟳ while pending — so both content
  // types read as the same "verified" outcome.
  document.getElementById('verdict-icon')!.textContent =
    fullyVerified ? '✓' : pending ? '⟳' : '⚠️'
  document.getElementById('verdict-text')!.textContent =
    d.localMode       ? 'Local node — RPC trusted' :
    heliosErr && (contractBlocked || ensBlocked) ? 'Helios error — could not load, nothing was verified' :
    contractBlocked && d.ensVerified === false ? 'Content differs from Helios — possible forgery' :
    contractBlocked   ? 'Unverified — Helios could not confirm content' :
    ensBlocked && d.ensVerified === false ? 'Name forged — record differs from Helios' :
    ensBlocked        ? 'Unverified — name not confirmed by Helios' :
    d.portalVerified  ? 'Verified — Portal Network' :
    d.heliosBacked    ? 'Verified by Helios' :
    beaconTrusted     ? 'Verified by Helios' :
    d.beaconVerified  ? 'Untrusted — beacon proof without Helios anchor' :
    pending           ? 'Verifying…' :
    heliosErr         ? 'Helios error — could not load, nothing was verified' :
    'Unverified — RPC trusted without proof'

  const set = (id: string, val: string) => {
    const el = document.getElementById(id); if (el) el.textContent = val
  }
  const showRow = (id: string, show: boolean) =>
    document.getElementById(id)!.classList.toggle('hidden', !show)

  set('pf-url', d.url ?? '—')

  // Multi-chunk websites have no single representative block or block hash. Keep their
  // individual locations in Chunks, but retain Source as a comparable summary.
  const chunks = d.chunks as Array<{ blockNumber: number; txIndex: number }> | undefined
  const multiChunk = !!chunks && chunks.length > 1
  showRow('pf-chunks-row', multiChunk)
  showRow('pf-block-row', !multiChunk)
  showRow('pf-block-hash-row', !multiChunk)
  showRow('pf-source-row', true)
  // Transaction calldata is immutable; a contract serves its current state. Show the same freshness
  // property for every path.
  showRow('pf-fresh-row', true)
  showRow('pf-name-row', isEns && !d.localMode)   // resolution — dotted-name targets of either kind

  if (multiChunk) {
    set('pf-chunks', chunks!.map(c => `${c.blockNumber}:${c.txIndex}`).join(', '))
    set('pf-source', `${chunks!.length} calldata transactions`)
  } else {
    set('pf-block',      d.blockNumber ? String(d.blockNumber) : pending ? '…' : '—')
    set('pf-block-hash', d.blockHash || (pending ? '…' : '—'))
    // Unified Source row: where the content came from on-chain.
    if (contractServed) set('pf-source', `contract ${d.contractAddress}`)
    else if (d.txHash)  set('pf-source', `tx ${d.txHash}${d.txIndex !== undefined ? `  ·  idx ${d.txIndex}` : ''}`)
    else if (d.blockNumber !== undefined && d.txIndex !== undefined) set('pf-source', `${d.blockNumber}:${d.txIndex}`)
    else set('pf-source', pending ? '…' : '—')
  }

  // Unified content-authenticity row (was "Body match" / "Trie verified").
  set('pf-content',
    d.localMode      ? 'N/A — local node trusted' :
    pending          ? 'Verifying…' :
    contractServed   ? (d.trieVerified ? 'YES — matches Helios eth_call' : 'NO — differs from Helios') :
    d.trieVerified   ? 'YES — cryptographically proven' : 'NO')

  if (contractServed) {
    // A contract's own Cache-Control claim (e.g. "immutable") can't be verified, so it never changes this label.
    set('pf-fresh', pending ? 'Verifying…' : 'Live — current contract state')
  } else {
    set('pf-fresh', pending ? 'Verifying…' : 'Immutable — transaction calldata')
  }

  let headerText = d.localMode ? 'N/A — local node trusted' : 'NO — trusted RPC only'
  if (d.portalVerified) {
    headerText = 'YES — Portal Network (sync committee BLS, local node)'
  } else if (d.heliosBacked) {
    headerText = 'YES — Helios sync-committee (BLS)'
  } else if (beaconTrusted) {
    const stateStep = d.beaconStateHashVerified ? 'hash_tree_root(BeaconState)' : 'SHA-256 Merkle only'
    headerText = 'YES — Helios EIP-4788 anchor → ' + stateStep + ' → historical_summaries[era] → execution cross-check'
  } else if (d.beaconVerified) {
    headerText = 'NO — beacon proof computed but Helios anchor missing (untrusted)'
  } else if (pending) {
    headerText = 'Verifying…'
  }
  set('pf-header', headerText)

  if (isEns && !d.localMode) {
    set('pf-name',
      d.ensVerified === true  ? 'YES — confirmed by Helios' :
      d.ensVerified === false ? 'MISMATCH — differs from Helios (possible forgery)' :
      pending                 ? 'Verifying…' :
      heliosErr               ? `Helios error — ${String(d.heliosError).slice(0, 120)}` :
                                'Unverified — Helios could not confirm',
    )
  }

  set('pf-ct',   d.contentType ?? '—')
  set('pf-size', d.payloadSize ?? '—')
}

load()
