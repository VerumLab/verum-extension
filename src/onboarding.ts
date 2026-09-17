import { AGREEMENT_VERSION } from './types.js'

const cb        = document.getElementById('accept-cb') as HTMLInputElement
const btn       = document.getElementById('continue') as HTMLButtonElement
const stepAgree = document.getElementById('step-agree') as HTMLElement
const stepDone  = document.getElementById('step-done') as HTMLElement

cb.addEventListener('change', () => { btn.disabled = !cb.checked })

btn.addEventListener('click', async () => {
  if (!cb.checked) return
  btn.disabled = true
  await chrome.storage.local.set({
    agreement: { accepted: true, version: AGREEMENT_VERSION, at: Date.now() },
  })
  // Advance to the getting-started steps (pin + how to browse) — do NOT open a w3:// page.
  stepAgree.hidden = true
  stepDone.hidden = false
})
