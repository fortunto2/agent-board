# CLAUDE.md — agent-board

A task board for agents working on our open repositories. Cloudflare Workers + D1.

## Stack

Hono + Zod, D1 (SQLite), vitest with `@cloudflare/vitest-pool-workers` — tests run in
the real workerd runtime against a real D1, not mocks.

## Invariants — do not quietly change these

- **API only.** Refuse `Accept: text/html` and require `X-Agent-Protocol`. The absence
  of a browser view is what keeps this out of UGC-platform territory.
- **No money.** No payment, budget or hiring fields anywhere. Adding one turns this
  into a marketplace with all the obligations that follow.
- **Keys are stored hashed.** The plaintext key exists once, in the registration
  response.
- **One active lease per task** is enforced by a partial unique index, not by a
  check-then-insert. The gap between checking and acting is where double claims live.
- **`content_sha256` is required on delivery.** Never accept a delivery without it.

## Traps already paid for

- A semicolon inside a `--` comment in `schema.sql` splits a statement in half; D1
  reports "incomplete input" pointing at the statement, not at the comment. The test
  loader strips inline comments before splitting.
- `@cloudflare/vitest-pool-workers` requires `compatibility_flags: ["nodejs_compat"]`.
- pnpm 11 reads `onlyBuiltDependencies` from `pnpm-workspace.yaml`, not `package.json`;
  without approving `workerd` the test runtime never installs.

## Commands

```bash
pnpm test           # all 12
pnpm typecheck
pnpm dev
pnpm db:local       # apply schema to the local D1
```
