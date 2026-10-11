import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { isRoom } from './src/shell/route.ts'

// The UI (4688) talks to the daemon fundd (4689). Vite only serves the UI; a UI restart
// never touches a running agent, terminal or dashboard, because fundd owns all of them.
const FUNDD = `http://127.0.0.1:${process.env.FUNDD_PORT ?? 4689}`

/** the vendor chunk a module belongs to: react, the terminal, markdown; everything else stays
 *  with whoever imports it (mermaid and its diagrams already split themselves on demand) */
function vendorOf(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
  if (/node_modules[\\/]@xterm[\\/]/.test(id)) return 'xterm'
  if (/node_modules[\\/]marked[\\/]/.test(id)) return 'marked'
  return undefined
}

/** FUND_BUNDLE_REPORT=1 npx vite build --outDir <scratch>: what a first paint costs. The shell
 *  (the entry and its static imports, with its biggest modules) plus, per room, the extra JS that
 *  room's chunk pulls in (main.tsx awaits the room on screen before it renders); the rest is lazy */
function bundleReport(): Plugin {
  return {
    name: 'fund-bundle-report',
    apply: 'build',
    generateBundle(_o, bundle) {
      if (!process.env.FUND_BUNDLE_REPORT) return
      const chunks = Object.values(bundle).filter(c => c.type === 'chunk')
      const byName = new Map(chunks.map(c => [c.fileName, c]))
      const closure = (f: string, into = new Set<string>()) => {
        if (!into.has(f)) { into.add(f); for (const i of byName.get(f)?.imports ?? []) closure(i, into) }
        return into
      }
      const shell = new Set<string>()
      for (const c of chunks) if (c.isEntry) closure(c.fileName, shell)
      const size = (fs: Iterable<string>) => [...fs].reduce((n, f) => n + (byName.get(f)?.code.length ?? 0), 0)
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
      const lines = [`shell JS ${kb(size(shell))}`]
      for (const f of shell) {
        const c = byName.get(f)!
        lines.push(`${kb(c.code.length).padStart(10)}  ${f}`)
        const by: Record<string, number> = {}
        for (const [id, m] of Object.entries(c.modules)) {
          const nm = id.split(/node_modules[\/]/).pop()!.split(/[\/]/)
          const k = id.includes('node_modules') ? nm.slice(0, nm[0].startsWith('@') ? 2 : 1).join('/') : id.replace(/.*[\/]src[\/]/, 'src/').split('/').slice(0, 3).join('/')
          by[k] = (by[k] ?? 0) + m.renderedLength
        }
        for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6)) lines.push(`${kb(v).padStart(18)}  ${k} (before minify)`)
      }
      lines.push('first paint per room (shell + the room chunk and what it imports):')
      for (const c of chunks) {
        const m = /[\/]rooms[\/]([a-z]+)[\/]index\.tsx$/.exec(c.facadeModuleId ?? '')
        if (!m || c.isEntry || !isRoom(m[1])) continue
        const extra = [...closure(c.fileName)].filter(f => !shell.has(f))
        lines.push(`${m[1].padStart(10)}  ${kb(size(shell) + size(extra))}  (+${kb(size(extra))}: ${extra.map(f => f.replace(/^assets\//, '').replace(/-[\w-]{8}\.js$/, '')).join(', ')})`)
      }
      const total = chunks.reduce((n, c) => n + c.code.length, 0)
      const css = Object.values(bundle).reduce((n, a) => n + (a.type === 'asset' && a.fileName.endsWith('.css') ? String(a.source).length : 0), 0)
      lines.push(`all JS ${kb(total)} · all css ${kb(css)}`)
      console.log(['', ...lines].join('\n'))
    },
  }
}

/** the room on screen starts loading WITH the shell, not after it: a tiny inline script in the
 *  built index.html reads the room the page will open (the URL's, else the remembered one, as
 *  main.tsx does) and preloads that room's chunk, what it imports and its css. Without it the
 *  lazy room is a second round trip after the entry has run */
function preloadRoom(): Plugin {
  return {
    name: 'fund-preload-room',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return html
        const chunks = Object.values(bundle).filter(c => c.type === 'chunk')
        const byName = new Map(chunks.map(c => [c.fileName, c]))
        const shell = new Set<string>()
        const walk = (f: string, into: Set<string>) => { if (!into.has(f)) { into.add(f); for (const i of byName.get(f)?.imports ?? []) walk(i, into) } }
        for (const c of chunks) if (c.isEntry) walk(c.fileName, shell)
        const js: Record<string, string[]> = {}, css: Record<string, string[]> = {}
        for (const c of chunks) {
          const m = /\/rooms\/([a-z]+)\/index\.tsx$/.exec(c.facadeModuleId ?? '')
          if (!m || c.isEntry || !isRoom(m[1])) continue
          const own = new Set<string>()
          walk(c.fileName, own)
          const files = [...own].filter(f => !shell.has(f))
          js[m[1]] = files
          css[m[1]] = [...new Set(files.flatMap(f => [...(byName.get(f)?.viteMetadata?.importedCss ?? [])]))]
        }
        if (!Object.keys(js).length) return html
        const script = `(function(){var J=${JSON.stringify(js)},C=${JSON.stringify(css)},r=(/^#\\/([a-z]+)/.exec(location.hash)||[])[1];` +
          `if(!J[r]){try{r=JSON.parse(localStorage.getItem('fundos.room'))}catch(e){}}if(!J[r])r='chats';` +
          `function a(rel,f){var l=document.createElement('link');l.rel=rel;l.href='/'+f;if(rel==='modulepreload')l.crossOrigin='';document.head.appendChild(l)}` +
          `(J[r]||[]).forEach(function(f){a('modulepreload',f)});(C[r]||[]).forEach(function(f){a('stylesheet',f)})})()`
        // first in <head>: a classic script after a stylesheet waits for it (and the fonts it imports)
        return { html, tags: [{ tag: 'script', children: script, injectTo: 'head-prepend' }] }
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), bundleReport(), preloadRoom()],
  build: {
    rollupOptions: { output: { manualChunks: vendorOf } },
  },
  server: {
    port: Number(process.env.FUND_UI_PORT ?? 4688),
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: FUNDD, changeOrigin: false },
      '/ws': { target: FUNDD.replace('http', 'ws'), ws: true },
    },
  },
})
