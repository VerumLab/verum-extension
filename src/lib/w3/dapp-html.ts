// Bundle → self-contained HTML for the dapp sandbox. Shared by renderer.ts
// (rendering fetched w3:// bundles) and deploy.ts (previewing local content
// before deployment) so the preview is byte-identical to the real render path.

import type { BundleFile } from './content.js'

// Stable origin used as the module resolution base inside srcdoc iframes.
// All bundle file paths are mapped to data: URIs under this origin via importmap.
export const DAPP_BASE = 'https://dapp.w3fs/'

// Rewrite relative import/export specifiers in a JS module to absolute DAPP_BASE URLs.
// When we inline a script from e.g. assets/index.js into the HTML root, its relative
// imports like ./chunk.js would resolve against the document root (wrong). Absolutifying
// them to https://dapp.w3fs/assets/chunk.js lets the import map catch them correctly.
export function absolutifyImports(code: string, scriptUrl: string): string {
  const dir = scriptUrl.slice(0, scriptUrl.lastIndexOf('/') + 1)
  code = code.replace(/\bimport\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_, q, spec) => `import(${q}${new URL(spec, dir).href}${q})`)
  code = code.replace(/\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
    (_, q, spec) => `from ${q}${new URL(spec, dir).href}${q}`)
  return code
}

export function toB64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
}

// Inline a bundle's HTML entry file: <base> injection, import map for JS files,
// stylesheet/script/img inlining, plus an asset map for JS-rendered images.
export function buildDappHtml(
  files: BundleFile[],
  entry: BundleFile,
): { html: string; assetMap: Record<string, string> } {
  const fileMap = new Map(files.map(f => [f.path, f]))
  function resolve(src: string) {
    if (!src || /^(https?:|data:|blob:)/.test(src)) return null
    return fileMap.get('/' + src.replace(/^\.?\//, '')) ?? null
  }

  let html = new TextDecoder().decode(entry.data)

  // Inject <base> so any remaining relative URLs in the document resolve here.
  if (!/<base\b/i.test(html)) {
    const baseTag = `<base href="${DAPP_BASE}">`
    html = /<head>/i.test(html)
      ? html.replace(/<head>/i, `<head>${baseTag}`)
      : baseTag + html
  }

  // Build import map: every JS file → data: URI with its own relative imports
  // already absolutified. This makes dynamic import('./chunk.js') inside any
  // data: module resolve through the map instead of hitting the network.
  const imports: Record<string, string> = {}
  for (const f of files) {
    const mt = f.mimeType.toLowerCase()
    if (mt.includes('javascript') || f.path.endsWith('.js')) {
      const rel = f.path.replace(/^\//, '')
      const scriptUrl = DAPP_BASE + rel
      const code = absolutifyImports(new TextDecoder().decode(f.data), scriptUrl)
      const dataUri = `data:text/javascript;base64,${toB64(new TextEncoder().encode(code))}`
      imports[scriptUrl] = dataUri
      imports['./' + rel] = dataUri
    }
  }

  if (Object.keys(imports).length > 0) {
    const importMapTag = `<script type="importmap">${JSON.stringify({ imports })}</script>`
    html = /<head>/i.test(html)
      ? html.replace(/<head>/i, `<head>${importMapTag}`)
      : importMapTag + html
  }

  // Build asset map for images/fonts dynamically rendered by JS (e.g. React components).
  // Passed to the sandbox so a MutationObserver polyfill can rewrite img.src at runtime.
  const assetMap: Record<string, string> = {}
  for (const f of files) {
    const mt = f.mimeType.toLowerCase()
    if (!mt.includes('javascript') && !mt.includes('html') && !mt.includes('css')) {
      const rel = f.path.replace(/^\//, '')
      assetMap[DAPP_BASE + rel] = `data:${f.mimeType};base64,${toB64(f.data)}`
    }
  }

  // <link href="..."> → <style>
  html = html.replace(/<link([^>]*?)>/gi, (match, attrs) => {
    const href = /\shref="([^"]+)"/i.exec(attrs)?.[1]
    const rel  = /\srel="([^"]+)"/i.exec(attrs)?.[1] ?? 'stylesheet'
    if (!href || !rel.includes('stylesheet')) return match
    const f = resolve(href)
    return f ? `<style>${new TextDecoder().decode(f.data)}</style>` : match
  })

  // All <script src="..."> → inline with imports absolutified to their original path.
  html = html.replace(/<script([^>]*?)\ssrc="([^"]+)"([^>]*?)>/gi, (match, pre, src, post) => {
    const f = resolve(src)
    if (!f) return match
    const scriptUrl = new URL(src.replace(/^\.\//, ''), DAPP_BASE).href
    const code = absolutifyImports(new TextDecoder().decode(f.data), scriptUrl)
    return `<script${pre}${post}>${code}`
  })

  // Static <img src="..."> in HTML → data URI
  html = html.replace(/(<img[^>]*?\ssrc=")([^"]+)(")/gi, (match, pre, src, post) => {
    const f = resolve(src)
    if (!f) return match
    return `${pre}data:${f.mimeType};base64,${toB64(f.data)}${post}`
  })

  return { html, assetMap }
}
