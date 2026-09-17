import { AGREEMENT_VERSION } from './types.js'

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

function showIdle() {
  // No active w3:// page → show only the URL bar + footer (settings/deploy).
  idle.classList.add('hidden')
  proof.classList.add('hidden')
}

function showProof(d: any) {
  if (d.url) navInput.value = d.url.replace('w3://', '')
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
    contractBlocked && d.ensVerified === false ? 'Content differs from Helios — possible forgery' :
    contractBlocked   ? 'Unverified — Helios could not confirm content' :
    ensBlocked && d.ensVerified === false ? 'Name forged — record differs from Helios' :
    ensBlocked        ? 'Unverified — name not confirmed by Helios' :
    d.portalVerified  ? 'Verified — Portal Network' :
    d.heliosBacked    ? 'Verified by Helios' :
    beaconTrusted     ? 'Verified by Helios' :
    d.beaconVerified  ? 'Untrusted — beacon proof without Helios anchor' :
    pending           ? 'Verifying…' :
    'Unverified — RPC trusted without proof'

  const set = (id: string, val: string) => {
    const el = document.getElementById(id); if (el) el.textContent = val
  }
  const showRow = (id: string, show: boolean) =>
    document.getElementById(id)!.classList.toggle('hidden', !show)

  set('pf-url', d.url ?? '—')

  // Multi-chunk dapps have no single representative block or block hash. Keep their
  // individual locations in Chunks, but retain Source as a comparable summary.
  const chunks = d.chunks as Array<{ blockNumber: number; txIndex: number }> | undefined
  const multiChunk = !!chunks && chunks.length > 1
  showRow('pf-chunks-row', multiChunk)
  showRow('pf-block-row', !multiChunk)
  showRow('pf-block-hash-row', !multiChunk)
  showRow('pf-source-row', true)
  // Transaction calldata is immutable; contracts may instead serve a live state or
  // an explicitly pinned artifact. Show the same freshness property for every path.
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
    const immutable = typeof d.cacheControl === 'string' && /immutable/i.test(d.cacheControl)
    set('pf-fresh', pending ? 'Verifying…' : immutable ? 'Immutable — pinned artifact' : 'Live — current contract state')
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
                                'Unverified — Helios could not confirm',
    )
  }

  set('pf-ct',   d.contentType ?? '—')
  set('pf-size', d.payloadSize ?? '—')
}

load()
