// A small "Copy" button for a value the user may want to compare elsewhere (checkpoint hash, slot, epoch).
export function copyButton(text: string, what = 'value'): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'copy-btn'
  b.textContent = 'Copy'
  b.title = `Copy ${what}`
  b.addEventListener('click', async (e) => {
    e.stopPropagation()   // never also toggles/selects the row it sits in
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓' } catch { b.textContent = 'Copy failed' }
    setTimeout(() => { b.textContent = 'Copy' }, 1500)
  })
  return b
}

// True when the click ended a text selection (dragging over the hash to select it): don't treat it as a click.
export const selectingText = () => (window.getSelection()?.toString() ?? '') !== ''

// A selectable piece of text (hash, slot, epoch), as opposed to plain label text.
export function selectable(text: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = `selectable ${cls}`.trim()
  s.textContent = text
  return s
}
