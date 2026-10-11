// A stand-in for `python -m fund_db usage|tier|prune|cache --json` (the store door), for
// test/data.test.ts and test/data-storage.test.ts: it answers each command from fixed data, never
// touches a lake, and appends every call it got to FAKE_LOG (one JSON line: {cmd, args, stdin}) so a
// test can see exactly what fundd sent. FAKE_MISSING=1 behaves as the module not being there yet.
import { appendFileSync } from 'node:fs'

const [cmd, ...args] = process.argv.slice(2)
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const raw = Buffer.concat(chunks).toString('utf8')
const stdin = raw ? JSON.parse(raw) : null
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd, args, stdin, raw }) + '\n')

const say = o => process.stdout.write(JSON.stringify(o) + '\n')
const NOW = Date.now()

if (process.env.FAKE_MISSING === '1') {
  process.stderr.write('python: No module named fund_db\n')
  process.exit(1)
}

switch (cmd) {
  case 'usage':
    say({ lake: { datasets: [], other: [], total_bytes: 0 }, ops: { database_bytes: 0, tables: [] } })
    break
  // the store door (fund_db tier|prune --json, B-0292): dataset 'partial' stops part-way on --apply
  case 'tier':
  case 'prune': {
    const ds = args.includes('--dataset') ? args[args.indexOf('--dataset') + 1] : null
    const items = [{ dataset: ds ?? 'candles', from: 'market/candles/venue=x/month=2026-01', to: 'cold/candles/venue=x/month=2026-01', bytes: 1_000_000 },
                   { dataset: ds ?? 'candles', from: 'market/candles/venue=x/month=2026-02', to: 'cold/candles/venue=x/month=2026-02', bytes: 2_000_000 }]
    if (ds === 'partial' && args.includes('--apply')) {
      say({ ok: false, kind: cmd, dataset: ds, apply: true, items: items.slice(0, 1), total_bytes: 1_000_000, error: 'OSError: the destination differs' })
      process.exit(1)
    }
    say({ ok: true, kind: cmd, dataset: ds, apply: args.includes('--apply'), items, total_bytes: 3_000_000 })
    break
  }
  // the store door's cache (fund_db cache --evict [--to N] [--dry-run] --json, B-0324): the two
  // least-recently-read months; FAKE_EVICT_MONTH moves the second one (the cache moved since a plan)
  case 'cache': {
    if (!args.includes('--evict')) { say({ ok: false, status: 400, error: 'fake: only --evict' }); process.exit(1) }
    const evicted = [{ dataset: 'funding', venue: 'example_a', interval: null, month: '2026-03', bytes: 40_000_000, last_read_ms: NOW - 9e8 },
                     { dataset: 'candles', venue: 'example_b', interval: '1h', month: process.env.FAKE_EVICT_MONTH ?? '2026-04', bytes: 60_000_000, last_read_ms: NOW - 8e8 }]
    say({ before_bytes: 2_247_483_648, after_bytes: 2_147_483_648, max_bytes: 2_147_483_648, dry_run: args.includes('--dry-run'), evicted })
    break
  }
  case 'garbage':
    process.stdout.write('this is not json\n')
    process.exit(3)
  default:
    say({ ok: false, status: 400, error: `unknown command ${cmd}` })
    process.exit(1)
}
