import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, readdirSync } from 'fs'

export default defineConfig({
  // Set root to src/ so HTML files resolve relative to it and output flat
  root: resolve(__dirname, 'src'),
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        renderer: resolve(__dirname, 'src/renderer.html'),
        popup: resolve(__dirname, 'src/popup.html'),
        settings: resolve(__dirname, 'src/settings.html'),
        onboarding: resolve(__dirname, 'src/onboarding.html'),
        terms: resolve(__dirname, 'src/terms.html'),
        deploy: resolve(__dirname, 'src/deploy.html'),
        background: resolve(__dirname, 'src/background.ts'),
        'dapp-sandbox':   resolve(__dirname, 'src/dapp-sandbox.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  plugins: [
    {
      // dapp-sandbox.html is a null-origin sandbox page — Vite's default crossorigin=""
      // on module scripts triggers CORS with Origin: null, which fails for extension
      // resources. Strip it (and the modulepreload link) from the built output.
      name: 'strip-sandbox-crossorigin',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!ctx.filename.endsWith('dapp-sandbox.html')) return html
          return html
            .replace(/<link rel="modulepreload"[^>]*>/gi, '')
            .replace(/(<script[^>]*)\s+crossorigin(?:="[^"]*")?/gi, '$1')
        },
      },
    },
    {
      name: 'copy-manifest',
      closeBundle() {
        mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true })
        copyFileSync(
          resolve(__dirname, 'public/manifest.json'),
          resolve(__dirname, 'dist/manifest.json'),
        )
        for (const f of readdirSync(resolve(__dirname, 'public/icons'))) {
          copyFileSync(resolve(__dirname, 'public/icons', f), resolve(__dirname, 'dist/icons', f))
        }
      },
    },
  ],
})
