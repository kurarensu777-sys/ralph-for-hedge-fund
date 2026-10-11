/**
 * vitest globalSetup: the run's throwaway PostgreSQL (cluster.ts) with one database, `fund_tpl`,
 * brought current by the SAME migration runner fundd uses (@fund/db migrate, database/'s files).
 * Every test file clones it (setup.ts). Torn down, data folder and all, when the run ends.
 */
import type { TestProject } from 'vitest/node'
import { closeAll, migrate, poolFor } from '@fund/db'
import { TEMPLATE, startCluster, type Cluster } from './cluster.ts'

declare module 'vitest' {
  export interface ProvidedContext { pgPort: number }
}

let cluster: Cluster | null = null

export default async function setup(project: TestProject) {
  const t0 = Date.now()
  cluster = await startCluster()
  const t1 = Date.now()
  const conn = (database: string) => ({ host: '127.0.0.1', port: cluster!.port, user: 'fund', database })
  try {
    await poolFor(conn('postgres')).query(`CREATE DATABASE ${TEMPLATE}`)
    const t2 = Date.now()
    const applied = await migrate({ conn: conn(TEMPLATE) })
    console.log(`[test] cluster up ${t1 - t0} ms, template created ${t2 - t1} ms, ${applied.length} migrations ${Date.now() - t2} ms`)
    if (!applied.length) throw new Error('the template database took no migration: database/migrations is empty or unreadable')
  } finally {
    await closeAll()      // nothing may stay connected to the template, or CREATE DATABASE ... TEMPLATE refuses
  }
  project.provide('pgPort', cluster.port)
  console.log(`[test] throwaway PostgreSQL on 127.0.0.1:${cluster.port} (${cluster.root}), template migrated in ${Date.now() - t0} ms`)
  return () => { cluster?.stop(); cluster = null }
}
