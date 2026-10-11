import { defineConfig, mergeConfig } from 'vitest/config'
import vite from './vite.config.ts'

// Several suites drive real git repos, hooks and the venv python; under a full parallel run
// the 5 s default times them out on load alone, so the whole suite gets one wider budget.
// The store: one throwaway PostgreSQL per run (test/pg/global.ts), one database per test file
// cloned from its migrated template (test/pg/setup.ts). The live cluster is never touched.
export default mergeConfig(vite, defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/pg/global.ts'],
    setupFiles: ['./test/pg/setup.ts'],
  },
}))
