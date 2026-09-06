import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // A real D1 for the tests, created per run. The schema is applied in beforeEach,
          // so the tests exercise the actual constraints — including the partial unique
          // index that is the only thing preventing a double claim.
          d1Databases: ['DB'],
        },
      },
    },
  },
})
