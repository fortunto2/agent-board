import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import schema from '../db/schema.sql?raw'

const H = {
  'X-Agent-Protocol': 'agent-board/1',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
}

async function register(name: string): Promise<string> {
  const r = await SELF.fetch('https://board.rustman.org/v1/agents', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name }),
  })
  return (await r.json<{ api_key: string }>()).api_key
}

async function seedTask(id = 'task-1', leaseHours = 48) {
  await env.DB.prepare(
    'INSERT INTO tasks (id, repo, title, body, acceptance, lease_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, 'github.com/fortunto2/solo-factory', 'Add Linux CI', 'why', 'CI is green on linux', leaseHours, 1)
    .run()
}

const auth = (key: string) => ({ ...H, Authorization: `Bearer ${key}` })

beforeEach(async () => {
  // Strip every -- comment, not just whole-line ones, before splitting on ';'.
  // A semicolon inside an inline comment cuts a CREATE TABLE in half and D1 reports
  // it as "incomplete input", which points at the statement rather than at the
  // comment that broke it. Cost twenty minutes to find; hence this note.
  const sql = schema
    .split('\n')
    .map((line: string) => line.replace(/--.*$/, ''))
    .join('\n')
  for (const stmt of sql.split(';').map((s: string) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run()
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deliveries'),
    env.DB.prepare('DELETE FROM leases'),
    env.DB.prepare('DELETE FROM tasks'),
    env.DB.prepare('DELETE FROM agents'),
  ])
})

describe('the API refuses what is not an agent', () => {
  it('requires the protocol header', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks', { headers: { Accept: 'application/json' } })
    expect(r.status).toBe(400)
    expect((await r.json<any>()).error.code).toBe('PROTOCOL_REQUIRED')
  })

  it('refuses a browser even with the header', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks', {
      headers: { ...H, Accept: 'text/html,application/xhtml+xml' },
    })
    expect(r.status).toBe(403)
    expect((await r.json<any>()).error.code).toBe('BROWSER_BLOCKED')
  })

  it('requires a key for everything but registration', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks', { headers: H })
    expect(r.status).toBe(401)
  })
})

describe('registration', () => {
  it('returns a key once and never stores it in the clear', async () => {
    const key = await register('first-agent')
    expect(key).toHaveLength(64)
    const row = await env.DB.prepare('SELECT key_hash FROM agents WHERE name = ?').bind('first-agent').first<any>()
    expect(row.key_hash).not.toContain(key)
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a duplicate name', async () => {
    await register('taken')
    const r = await SELF.fetch('https://board.rustman.org/v1/agents', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'taken' }),
    })
    expect(r.status).toBe(409)
  })

  it('rejects a name that is not a slug', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/agents', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Not A Slug' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('claiming is exclusive', () => {
  it('lets one agent claim and refuses the second', async () => {
    await seedTask()
    const a = await register('agent-a')
    const b = await register('agent-b')

    const first = await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/claim', {
      method: 'POST',
      headers: auth(a),
    })
    expect(first.status).toBe(200)

    const second = await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/claim', {
      method: 'POST',
      headers: auth(b),
    })
    // The task is no longer open, so the second agent is turned away before the index
    // is even consulted. Either code is correct; what must not happen is two leases.
    expect([409]).toContain(second.status)

    const leases = await env.DB.prepare("SELECT COUNT(*) AS n FROM leases WHERE state = 'active'").first<any>()
    expect(leases.n).toBe(1)
  })
})

describe('delivery', () => {
  it('requires an active lease', async () => {
    await seedTask()
    const a = await register('no-lease')
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/deliver', {
      method: 'POST',
      headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/pr/1', content_sha256: 'a'.repeat(64) }),
    })
    expect(r.status).toBe(409)
    expect((await r.json<any>()).error.code).toBe('NO_LEASE')
  })

  it('requires a real sha256, not a promise', async () => {
    await seedTask()
    const a = await register('claimer')
    await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/claim', { method: 'POST', headers: auth(a) })
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/deliver', {
      method: 'POST',
      headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/pr/1', content_sha256: 'not-a-hash' }),
    })
    expect(r.status).toBe(400)
  })

  it('records the delivery and frees the lease', async () => {
    await seedTask()
    const a = await register('deliverer')
    await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/claim', { method: 'POST', headers: auth(a) })
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/task-1/deliver', {
      method: 'POST',
      headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/pr/1', content_sha256: 'b'.repeat(64), notes: 'done' }),
    })
    expect(r.status).toBe(200)
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind('task-1').first<any>()
    expect(task.status).toBe('delivered')
    const lease = await env.DB.prepare('SELECT state FROM leases WHERE task_id = ?').bind('task-1').first<any>()
    expect(lease.state).toBe('delivered')
  })
})

describe('an abandoned lease returns the task to the pool', () => {
  it('expires and reopens on the scheduled run', async () => {
    await seedTask('task-old', 48)
    const a = await register('vanisher')
    await SELF.fetch('https://board.rustman.org/v1/tasks/task-old/claim', { method: 'POST', headers: auth(a) })

    // Backdate the lease rather than waiting two days.
    await env.DB.prepare('UPDATE leases SET expires_at = 1 WHERE task_id = ?').bind('task-old').run()

    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)

    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind('task-old').first<any>()
    expect(task.status).toBe('open')
    const lease = await env.DB.prepare('SELECT state FROM leases WHERE task_id = ?').bind('task-old').first<any>()
    expect(lease.state).toBe('expired')
  })

  it('and can then be claimed by someone else', async () => {
    await seedTask('task-old')
    const a = await register('first-holder')
    const b = await register('second-holder')
    await SELF.fetch('https://board.rustman.org/v1/tasks/task-old/claim', { method: 'POST', headers: auth(a) })
    await env.DB.prepare('UPDATE leases SET expires_at = 1 WHERE task_id = ?').bind('task-old').run()
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)

    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/task-old/claim', {
      method: 'POST',
      headers: auth(b),
    })
    expect(r.status).toBe(200)
  })
})

describe('the front door', () => {
  it('serves HTML at / and lists open tasks by title', async () => {
    await seedTask('visible-task')
    const r = await SELF.fetch('https://board.rustman.org/')
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('Take a task')
    expect(html).toContain('visible-task')
    expect(html).toContain('Copy')
  })

  it('never renders a delivery — those are other agents text', async () => {
    await seedTask('t')
    const key = await register('deliverer-x')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(key) })
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST',
      headers: auth(key),
      body: JSON.stringify({
        url: 'https://example.com/pr/9',
        content_sha256: 'c'.repeat(64),
        notes: 'SOME-AGENT-SUPPLIED-TEXT',
      }),
    })
    const html = await (await SELF.fetch('https://board.rustman.org/')).text()
    expect(html).not.toContain('SOME-AGENT-SUPPLIED-TEXT')
    expect(html).not.toContain('example.com/pr/9')
  })

  it('escapes task text rather than trusting it', async () => {
    await env.DB.prepare(
      'INSERT INTO tasks (id, repo, title, body, acceptance, lease_hours, created_at) VALUES (?,?,?,?,?,?,?)',
    )
      .bind('x', 'r', '<script>alert(1)</script>', 'b', 'a', 48, 1)
      .run()
    const html = await (await SELF.fetch('https://board.rustman.org/')).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('serves the documents an agent needs', async () => {
    for (const [path, needle] of [
      ['/skill.md', 'X-Agent-Protocol'],
      ['/llms.txt', 'agent-board'],
      ['/openapi.json', 'openapi'],
    ] as const) {
      const r = await SELF.fetch(`https://board.rustman.org${path}`)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain(needle)
    }
  })
})

describe('watching what happens', () => {
  it('shows live counters on the landing', async () => {
    await seedTask('counted')
    await register('counted-agent')
    const html = await (await SELF.fetch('https://board.rustman.org/')).text()
    expect(html).toContain('agents')
    expect(html).toMatch(/<b>1<\/b> agents/)
    expect(html).toMatch(/<b>1<\/b> open/)
  })

  it('/v1/stats returns aggregates only — no names, no URLs', async () => {
    await seedTask('t')
    const key = await register('statty')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(key) })
    const r = await SELF.fetch('https://board.rustman.org/v1/stats', { headers: auth(key) })
    const body = await r.text()
    expect(r.status).toBe(200)
    expect(body).not.toContain('statty')
    expect(JSON.parse(body).active_leases).toBe(1)
  })

  it('the operator view is refused to everyone else', async () => {
    const key = await register('not-the-operator')
    const r = await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(key) })
    expect(r.status).toBe(403)
  })

  it('the operator sees who claimed and who delivered', async () => {
    await seedTask('t')
    const admin = await register('rustman')          // matches ADMIN_AGENT
    const worker = await register('some-worker')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(worker) })
    const r = await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    expect(r.status).toBe(200)
    const d = await r.json<any>()
    const kinds = d.recent.map((x: any) => `${x.kind}:${x.agent}`)
    expect(kinds).toContain('claim:some-worker')
    expect(kinds).toContain('register:some-worker')
    expect(d.counts.agents).toBe(2)
  })
})
