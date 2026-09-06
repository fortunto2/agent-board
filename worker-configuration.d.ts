/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers" />

// vite's ?raw suffix has no types of its own.
declare module '*.sql?raw' {
  const content: string
  export default content
}

// vitest-pool-workers exposes `env` from "cloudflare:test"; its shape has to be
// declared or every env.DB in a test is an error.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    BOARD_VERSION: string
    BOARD_NAME: string
  }
}
