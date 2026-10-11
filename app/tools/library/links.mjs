// The library link audit from a shell: asks the running fundd (GET /api/library/links) and prints
// one line per fault. Exit 0 = no faults, 1 = faults, 2 = fundd unreachable or the audit failed.
//   node app/tools/library/links.mjs [--json] [--port 4689]
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const port = Number(arg('--port', process.env.FUNDD_PORT ?? 4689))
let d
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/library/links`)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  d = await r.json()
} catch (e) {
  console.error(`links: unknown - ${e.message ?? e}`)
  process.exit(2)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(d, null, 2))
else {
  for (const r of d.rows) console.log(`${r.fault.padEnd(12)} ${r.agent ? `${r.agent} ` : ''}${r.path}${r.target ? `  missing ${r.target}` : ''}`)
  console.log(`links ${d.rows.length} · books ${d.books} · series ${d.series} · CLAUDE.md ${d.claude} · ${new Date(d.scanned).toISOString()}`)
}
process.exit(d.rows.length ? 1 : 0)
