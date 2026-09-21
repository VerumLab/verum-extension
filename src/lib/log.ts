// Verbose [w3] verification trace, gated behind the dev-mode setting so production
// installs stay quiet in DevTools. console.warn / console.error are intentionally
// NOT routed through here — real problems should always surface.
//
// Module state is per-context (the background worker and each extension page get
// their own instance), so every entry point that emits traces calls initW3Debug().

let debugOn = false

export function w3log(...args: unknown[]): void {
  if (debugOn) console.log(...args)
}

export function setW3Debug(on: boolean): void {
  debugOn = on
}

// Read the dev-mode flag once and keep it live. Safe to call anywhere: if
// chrome.storage is unavailable the trace simply stays off.
export function initW3Debug(): void {
  try {
    chrome.storage.sync.get('devMode')
      .then(v => { debugOn = v?.devMode === true })
      .catch(() => { /* default off */ })
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.devMode) debugOn = changes.devMode.newValue === true
    })
  } catch { /* no chrome.storage in this context — stay off */ }
}
