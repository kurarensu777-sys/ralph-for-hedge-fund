/** node src/cli.ts migrate [--status] - the node twin of `python -m fund_db migrate` */
import { closeAll } from './db.ts'
import { migrate, status } from './migrate.ts'

const [verb, flag] = process.argv.slice(2)
try {
  if (verb !== 'migrate') throw new Error('usage: node src/cli.ts migrate [--status]')
  if (flag === '--status') {
    const p = await status()
    for (const m of p.applied) console.log(`applied  ${m.track}/${m.file}`)
    for (const m of p.pending) console.log(`PENDING  ${m.track}/${m.file}`)
    for (const d of p.drift) console.log(`DRIFT    ${d.track}/${d.file}`)
    for (const u of p.unknown) console.log(`UNKNOWN  ${u.track}/${u.file}`)
    process.exitCode = p.drift.length ? 1 : 0
  } else {
    const done = await migrate({ log: console.log })
    console.log(done.length ? `[migrate] ${done.length} applied` : '[migrate] up to date')
  }
} catch (e) {
  console.error(`[fund_db] ${verb} FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await closeAll()
}
