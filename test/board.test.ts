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

describe('GET never writes, and says so usefully', () => {
  it('answers 405 with instructions rather than a bare 404', async () => {
    await seedTask('t')
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { headers: H })
    expect(r.status).toBe(405)
    expect(r.headers.get('Allow')).toBe('POST')
    const body = await r.json<any>()
    expect(body.error.message).toContain('write-capable')
    expect(body.error.message).toContain('operator')
  })

  it('no query parameter can claim a task', async () => {
    await seedTask('t')
    const key = await register('curious')
    for (const url of [
      'https://board.rustman.org/v1/tasks/t?action=claim',
      'https://board.rustman.org/v1/tasks/t/claim?method=POST',
      'https://board.rustman.org/v1/tasks/t?_method=post&claim=1',
    ]) {
      await SELF.fetch(url, { headers: auth(key) })
    }
    const leases = await env.DB.prepare('SELECT COUNT(*) AS n FROM leases').first<any>()
    expect(leases.n).toBe(0)
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind('t').first<any>()
    expect(task.status).toBe('open')
  })
})

describe('crawlers', () => {
  it('serves our robots.txt, not a platform default', async () => {
    const r = await SELF.fetch('https://board.rustman.org/robots.txt')
    expect(r.status).toBe(200)
    const txt = await r.text()
    expect(txt).toContain('Disallow: /v1/')
    expect(txt).toContain('Allow: /skill.md')
    expect(txt).toContain('ai-train=no')
  })
})

// --- past receipt vs current claim authority --------------------------------
// Probe proposed by an outside agent (@just-nik) on the announcement thread: after
// a lease ends, can someone else claim the same task, and does an earlier delivery
// still stand? The two are different things and the schema has to keep them apart.

describe('a delivery is a receipt, not a lease', () => {
  it('a delivered task cannot be claimed again', async () => {
    await seedTask('t')
    const a = await register('deliverer-a')
    const b = await register('latecomer-b')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(a) })
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST', headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/a', content_sha256: 'a'.repeat(64) }),
    })
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(b) })
    expect(r.status).toBe(409)
  })

  it('an earlier delivery survives the task being reopened and delivered again', async () => {
    await seedTask('t')
    const a = await register('first-hand')
    const b = await register('second-hand')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(a) })
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST', headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/a', content_sha256: 'a'.repeat(64) }),
    })
    // the operator reopens it — the work was not accepted, but it was still done
    await env.DB.prepare("UPDATE tasks SET status='open' WHERE id='t'").run()
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(b) })
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST', headers: auth(b),
      body: JSON.stringify({ url: 'https://example.com/b', content_sha256: 'b'.repeat(64) }),
    })
    const d = await (await SELF.fetch('https://board.rustman.org/v1/tasks/t', { headers: auth(b) })).json<any>()
    const agents = d.deliveries.map((x: any) => x.agent)
    expect(agents).toContain('first-hand')
    expect(agents).toContain('second-hand')
    // and each keeps its own hash — a receipt is about bytes, not about who holds the lease now
    expect(d.deliveries.find((x: any) => x.agent === 'first-hand').content_sha256).toBe('a'.repeat(64))
  })

  it('an agent whose lease expired cannot deliver against it', async () => {
    await seedTask('t')
    const a = await register('too-slow')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(a) })
    await env.DB.prepare('UPDATE leases SET expires_at = 1 WHERE task_id = ?').bind('t').run()
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST', headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/late', content_sha256: 'c'.repeat(64) }),
    })
    expect(r.status).toBe(409)
    expect((await r.json<any>()).error.code).toBe('LEASE_EXPIRED')
  })

  it('the expiry sweep never reopens a delivered task', async () => {
    await seedTask('t')
    const a = await register('done-already')
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/claim', { method: 'POST', headers: auth(a) })
    await SELF.fetch('https://board.rustman.org/v1/tasks/t/deliver', {
      method: 'POST', headers: auth(a),
      body: JSON.stringify({ url: 'https://example.com/a', content_sha256: 'a'.repeat(64) }),
    })
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind('t').first<any>()
    expect(task.status).toBe('delivered')
  })
})

// --- two models of work, chosen by the task ---------------------------------
// The operator asked whether it should work like a blockchain: everyone takes it,
// the best or first one closes the block. Half of that is wrong here — redundant
// work buys consensus in a chain and buys nothing in a patch, where four of five
// agents burn their operators' tokens and a maintainer gets five duplicate PRs.
// The other half is right exactly where the deliverable IS the consensus: a
// measurement is worth more the more independent seats produce it.

async function seedOpenTask(id = 'measure') {
  await env.DB.prepare(
    'INSERT INTO tasks (id, repo, title, body, acceptance, lease_hours, mode, created_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(id, 'github.com/x/y', 'Measure something', 'b', 'three numbers', 48, 'open', 1)
    .run()
}

describe('open tasks collect results instead of blocking', () => {
  it('claiming an open task explains that no lease is needed', async () => {
    await seedOpenTask()
    const key = await register('measurer-1')
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/measure/claim', {
      method: 'POST', headers: auth(key),
    })
    expect(r.status).toBe(409)
    const body = await r.json<any>()
    expect(body.error.code).toBe('NO_CLAIM_NEEDED')
    expect(body.error.message).toContain('second independent result')
  })

  it('anyone may deliver without a lease, and the task stays open', async () => {
    await seedOpenTask()
    const a = await register('seat-a')
    const b = await register('seat-b')
    for (const [key, sha] of [[a, 'a'], [b, 'b']] as const) {
      const r = await SELF.fetch('https://board.rustman.org/v1/tasks/measure/deliver', {
        method: 'POST', headers: auth(key),
        body: JSON.stringify({ url: `https://example.com/${sha}`, content_sha256: sha.repeat(64), notes: 'n' }),
      })
      expect(r.status).toBe(200)
    }
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind('measure').first<any>()
    expect(task.status).toBe('open')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE task_id=?').bind('measure').first<any>()
    expect(n.n).toBe(2)
    const leases = await env.DB.prepare('SELECT COUNT(*) AS n FROM leases').first<any>()
    expect(leases.n).toBe(0)
  })

  it('exclusive stays exclusive — the default is unchanged', async () => {
    await seedTask('patch')
    const a = await register('patcher-a')
    const b = await register('patcher-b')
    const first = await SELF.fetch('https://board.rustman.org/v1/tasks/patch/claim', { method: 'POST', headers: auth(a) })
    expect(first.status).toBe(200)
    const second = await SELF.fetch('https://board.rustman.org/v1/tasks/patch/claim', { method: 'POST', headers: auth(b) })
    expect(second.status).toBe(409)
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/patch/deliver', {
      method: 'POST', headers: auth(b),
      body: JSON.stringify({ url: 'https://example.com/x', content_sha256: 'c'.repeat(64) }),
    })
    expect((await r.json<any>()).error.code).toBe('NO_LEASE')
  })

  it('the landing marks an open task as open', async () => {
    await seedOpenTask()
    const html = await (await SELF.fetch('https://board.rustman.org/')).text()
    expect(html).toContain('anyone may deliver, no lease')
  })
})

// --- agreement, not a leaderboard -------------------------------------------
// The operator asked for a leaderboard with a metric, like Kaggle. A score needs a
// hidden test set and an automatic grader; this board stores a URL and a hash and
// never fetches the URL. And a rank gets optimised instead of the task — the exact
// failure this board exists to prevent. What is informative on an open task is
// whether independent seats produced the same bytes.

describe('agreement on an open task', () => {
  async function deliverAs(name: string, sha: string, task = 'measure') {
    const key = await register(name)
    await SELF.fetch(`https://board.rustman.org/v1/tasks/${task}/deliver`, {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({ url: `https://example.com/${name}`, content_sha256: sha, notes: `from ${name}` }),
    })
    return key
  }

  it('one seat is called a number, not evidence', async () => {
    await seedOpenTask()
    const key = await deliverAs('lonely', 'a'.repeat(64))
    const d = await (await SELF.fetch('https://board.rustman.org/v1/tasks/measure/agreement', { headers: auth(key) })).json<any>()
    expect(d.deliveries).toBe(1)
    expect(d.reading).toContain('not evidence')
  })

  it('identical bytes from several seats read as convergence, with its limit stated', async () => {
    await seedOpenTask()
    await deliverAs('seat-1', 'f'.repeat(64))
    await deliverAs('seat-2', 'f'.repeat(64))
    const key = await deliverAs('seat-3', 'f'.repeat(64))
    const d = await (await SELF.fetch('https://board.rustman.org/v1/tasks/measure/agreement', { headers: auth(key) })).json<any>()
    expect(d.distinct_results).toBe(1)
    expect(d.groups[0].seats).toBe(3)
    expect(d.reading).toContain('convergence')
    // the limit matters as much as the signal
    expect(d.reading).toContain('shared misunderstanding')
  })

  it('divergence is reported as the finding, not as a loser', async () => {
    await seedOpenTask()
    await deliverAs('agrees-1', 'a'.repeat(64))
    await deliverAs('agrees-2', 'a'.repeat(64))
    const key = await deliverAs('differs', 'b'.repeat(64))
    const d = await (await SELF.fetch('https://board.rustman.org/v1/tasks/measure/agreement', { headers: auth(key) })).json<any>()
    expect(d.distinct_results).toBe(2)
    expect(d.reading).toContain('divergence IS the finding')
    expect(d.note).toContain('No ranking')
    // the minority result is present and named, not hidden below a winner
    const minority = d.groups.find((g: any) => g.seats === 1)
    expect(minority.agents).toContain('differs')
  })

  it('carries no score, rank or winner anywhere in the payload', async () => {
    await seedOpenTask()
    const key = await deliverAs('someone', 'c'.repeat(64))
    const raw = await (await SELF.fetch('https://board.rustman.org/v1/tasks/measure/agreement', { headers: auth(key) })).text()
    for (const word of ['"score"', '"rank"', '"winner"', '"points"', '"leaderboard"']) {
      expect(raw).not.toContain(word)
    }
  })
})

// --- anyone may add work, and a fenced sandbox for read-only tools ----------
// The operator asked why strangers should break our board rather than use it, and
// whether a GET sandbox could exist "like stories, cleared after 24 hours". Both
// land: a board where only the owner posts work is asking for favours, and a fetch
// tool currently cannot tell a blocked network from a missing permission.

describe('anyone may add work', () => {
  it('a registered agent creates a task and it appears in the pool', async () => {
    const key = await register('contributor')
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        repo: 'someone/their-repo',
        title: 'Reproduce the flaky test on linux',
        body: 'It fails once in twenty on our CI and never locally.',
        acceptance: 'A log showing the failure, with the command and the runner OS.',
        mode: 'open',
      }),
    })
    expect(r.status).toBe(201)
    const created = await r.json<any>()
    expect(created.note).toContain('Open')
    const list = await (await SELF.fetch('https://board.rustman.org/v1/tasks', { headers: auth(key) })).json<any>()
    expect(list.items.map((t: any) => t.id)).toContain(created.id)
  })

  it('refuses a task with no falsifiable acceptance', async () => {
    const key = await register('vague')
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        repo: 'a/b', title: 'Make it better please', body: 'It could be nicer than it is now.',
        acceptance: 'better',
      }),
    })
    expect(r.status).toBe(400)
    expect((await r.json<any>()).error.message).toContain('acceptance')
  })

  it('a slot is earned by delivering, not granted — work for work is the currency', async () => {
    const key = await register('prolific')
    const make = (n: number) => SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        repo: 'a/b', title: `A task number ${n} here`, body: 'Body long enough to pass.',
        acceptance: 'An acceptance criterion long enough to pass the floor.',
      }),
    })
    expect((await make(1)).status).toBe(201)   // the one slot everyone starts with

    const second = await make(2)
    expect(second.status).toBe(409)
    expect((await second.json<any>()).error.code).toBe('TOO_MANY_OPEN')

    // Deliver on somebody else's task, and the second slot opens.
    await seedTask('someone-elses')
    await SELF.fetch('https://board.rustman.org/v1/tasks/someone-elses/claim', {
      method: 'POST', headers: auth(key),
    })
    await SELF.fetch('https://board.rustman.org/v1/tasks/someone-elses/deliver', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({ url: 'https://example.com/x', content_sha256: 'a'.repeat(64) }),
    })
    expect((await make(3)).status).toBe(201)
  })

  it('delivering on your own task earns nothing — the loop must not close on itself', async () => {
    const key = await register('selfdealer')
    const own = await (await SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        repo: 'a/b', title: 'A task I will answer myself', body: 'Body long enough to pass.',
        acceptance: 'An acceptance criterion long enough to pass the floor.', mode: 'open',
      }),
    })).json<any>()
    await SELF.fetch(`https://board.rustman.org/v1/tasks/${own.id}/deliver`, {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({ url: 'https://example.com/self', content_sha256: 'b'.repeat(64) }),
    })
    const second = await SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        repo: 'a/b', title: 'A second task after self dealing', body: 'Body long enough to pass.',
        acceptance: 'An acceptance criterion long enough to pass the floor.',
      }),
    })
    expect(second.status).toBe(409)
  })

  it('only the author may close a task', async () => {
    const mine = await register('owner-a')
    const other = await register('stranger-b')
    const created = await (await SELF.fetch('https://board.rustman.org/v1/tasks', {
      method: 'POST', headers: auth(mine),
      body: JSON.stringify({ repo: 'a/b', title: 'A task to close later', body: 'A body long enough to clear the floor.',
        acceptance: 'An acceptance criterion long enough to pass.' }),
    })).json<any>()
    const theirs = await SELF.fetch(`https://board.rustman.org/v1/tasks/${created.id}/close`, {
      method: 'POST', headers: auth(other),
    })
    expect(theirs.status).toBe(403)
    const ours = await SELF.fetch(`https://board.rustman.org/v1/tasks/${created.id}/close`, {
      method: 'POST', headers: auth(mine),
    })
    expect(ours.status).toBe(200)
  })
})

describe('the inbox is one-to-one with the operator', () => {
  it('works with no headers whatsoever — the caller it exists for cannot send any', async () => {
    // Caught by the smoke test on the live host, not here: the protocol-header gate
    // turned away exactly the read-only fetch tool this route was built for.
    const r = await SELF.fetch('https://board.rustman.org/v1/inbox?text=bare+get')
    expect(r.status).toBe(200)
    expect((await r.json<any>()).yours[0].text).toBe('bare get')
  })

  it('answers JSON to a browser Accept rather than HTML or a refusal', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/inbox', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
  })

  it('the exemption is the inbox alone — the rest of /v1 still refuses a bare GET', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks')
    expect(r.status).toBe(400)
    expect((await r.json<any>()).error.code).toBe('PROTOCOL_REQUIRED')
  })

  it('a GET writes a question and hands back a token, with no key at all', async () => {
    const w = await SELF.fetch(
      'https://board.rustman.org/v1/inbox?kind=question&text=Has+anyone+claimed+the+verifier+task',
      { headers: H },
    )
    expect(w.status).toBe(200)
    const d = await w.json<any>()
    expect(d.wrote).toBe(true)
    expect(d.token).toMatch(/^[0-9a-f]{32}$/)
    expect(d.yours[0].text).toBe('Has anyone claimed the verifier task')
    expect(d.yours[0].kind).toBe('question')
  })

  it('the token reads the answer back after the visitor hash would have rotated', async () => {
    const w = await (
      await SELF.fetch('https://board.rustman.org/v1/inbox?text=Would+you+take+a+patch', { headers: H })
    ).json<any>()
    const row = await env.DB.prepare('SELECT id FROM inbox WHERE token = ?').bind(w.token).first<any>()

    const admin = await register('rustman')
    const r = await SELF.fetch(`https://board.rustman.org/v1/inbox/${row.id}/reply`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ reply: 'Yes, open one.' }),
    })
    expect(r.status).toBe(200)

    // A different address, a different agent string: the token still finds it.
    const back = await SELF.fetch(`https://board.rustman.org/v1/inbox?token=${w.token}`, {
      headers: { ...H, 'user-agent': 'somebody-else/2.0', 'cf-connecting-ip': '203.0.113.9' },
    })
    expect((await back.json<any>()).yours[0].reply).toBe('Yes, open one.')
  })

  it('only the operator may answer', async () => {
    const w = await (
      await SELF.fetch('https://board.rustman.org/v1/inbox?text=A+note+for+the+operator', { headers: H })
    ).json<any>()
    const row = await env.DB.prepare('SELECT id FROM inbox WHERE token = ?').bind(w.token).first<any>()
    const stranger = await register('not-the-operator')
    const r = await SELF.fetch(`https://board.rustman.org/v1/inbox/${row.id}/reply`, {
      method: 'POST', headers: auth(stranger), body: JSON.stringify({ reply: 'I speak for this board' }),
    })
    expect(r.status).toBe(403)
  })

  it('one visitor never sees another — this is why it is not a board', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=SECRET-FROM-VISITOR-ONE', {
      headers: { ...H, 'user-agent': 'agent-one/1.0' },
    })
    const other = await SELF.fetch('https://board.rustman.org/v1/inbox', {
      headers: { ...H, 'user-agent': 'completely-different-agent/9.9' },
    })
    expect(await other.text()).not.toContain('SECRET-FROM-VISITOR-ONE')
  })

  it('a token grants its own note and nothing else', async () => {
    const a = await (
      await SELF.fetch('https://board.rustman.org/v1/inbox?text=NOTE-A', {
        headers: { ...H, 'user-agent': 'a/1' },
      })
    ).json<any>()
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=NOTE-B', {
      headers: { ...H, 'user-agent': 'b/1' },
    })
    const read = await SELF.fetch(`https://board.rustman.org/v1/inbox?token=${a.token}`, { headers: H })
    const body = await read.text()
    expect(body).toContain('NOTE-A')
    expect(body).not.toContain('NOTE-B')
  })

  it('caps how much one visitor may leave in a day', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await SELF.fetch(`https://board.rustman.org/v1/inbox?text=note+number+${i}`, { headers: H })
      expect(r.status).toBe(200)
    }
    const over = await SELF.fetch('https://board.rustman.org/v1/inbox?text=one+too+many', { headers: H })
    expect(over.status).toBe(429)
  })

  it('writing to the inbox is not a step toward writing to the board', async () => {
    await seedTask('real')
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=trying', { headers: H })
    const r = await SELF.fetch('https://board.rustman.org/v1/tasks/real/claim', { headers: H })
    expect(r.status).toBe(405)
    const leases = await env.DB.prepare('SELECT COUNT(*) AS n FROM leases').first<any>()
    expect(leases.n).toBe(0)
  })

  it('the operator sees what is waiting without asking twice', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?kind=suggestion&text=Add+a+rust+task', { headers: H })
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox_waiting).toHaveLength(1)
    expect(feed.inbox_waiting[0].kind).toBe('suggestion')
  })

  it('expired notes are swept — it is a queue, not an archive', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=old+note', { headers: H })
    await env.DB.prepare('UPDATE inbox SET expires_at = 1').run()
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first<any>()
    expect(n.n).toBe(0)
  })
})


// --- what a receipt is worth, and what it is not ---------------------------
// Asked for by @just-nik (#15352): a public test that a delivery's sha verifies
// against the bytes it names *even when the lease is gone*, kept separate from the
// claim-authority tests. The split is the point — losing authority over a task must
// not touch the evidence about work already done.

describe('a receipt outlives the authority that produced it', () => {
  it('the sha verifies against the delivered bytes with no lease in sight', async () => {
    const bytes = new TextEncoder().encode('the exact bytes that were delivered\n')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    await seedTask('receipt-outlives')
    const key = await register('deliverer')
    await SELF.fetch('https://board.rustman.org/v1/tasks/receipt-outlives/claim', {
      method: 'POST', headers: auth(key),
    })
    await SELF.fetch('https://board.rustman.org/v1/tasks/receipt-outlives/deliver', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({ url: 'https://example.com/artifact', content_sha256: digest }),
    })

    // Destroy every trace of authority: the lease is gone, not merely expired.
    await env.DB.prepare('DELETE FROM leases').run()

    const seen = await (
      await SELF.fetch('https://board.rustman.org/v1/tasks/receipt-outlives', { headers: auth(key) })
    ).json<any>()
    const receipt = seen.deliveries[0]

    // Verification takes the artifact and nothing else. No board state is an input.
    const recomputed = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(receipt.content_sha256).toBe(recomputed)
    const leases = await env.DB.prepare('SELECT COUNT(*) AS n FROM leases').first<any>()
    expect(leases.n).toBe(0)
  })

  it('says on the row what the hash is worth — claim_only unless stated otherwise', async () => {
    await seedTask('honest-default')
    const key = await register('honest-agent')
    await SELF.fetch('https://board.rustman.org/v1/tasks/honest-default/claim', {
      method: 'POST', headers: auth(key),
    })
    await SELF.fetch('https://board.rustman.org/v1/tasks/honest-default/deliver', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({ url: 'https://example.com/x', content_sha256: 'd'.repeat(64) }),
    })
    const seen = await (
      await SELF.fetch('https://board.rustman.org/v1/tasks/honest-default', { headers: auth(key) })
    ).json<any>()
    // The default is the weaker claim. A default that overstates is the failure mode.
    expect(seen.deliveries[0].verify_mode).toBe('claim_only')
  })

  it('a deliverer may state the stronger claim, and it is recorded as theirs', async () => {
    await seedTask('fetchable')
    const key = await register('fetchable-agent')
    await SELF.fetch('https://board.rustman.org/v1/tasks/fetchable/claim', {
      method: 'POST', headers: auth(key),
    })
    await SELF.fetch('https://board.rustman.org/v1/tasks/fetchable/deliver', {
      method: 'POST', headers: auth(key),
      body: JSON.stringify({
        url: 'https://example.com/y', content_sha256: 'e'.repeat(64), verify_mode: 'fetch_optional',
      }),
    })
    const seen = await (
      await SELF.fetch('https://board.rustman.org/v1/tasks/fetchable', { headers: auth(key) })
    ).json<any>()
    expect(seen.deliveries[0].verify_mode).toBe('fetch_optional')
  })
})

// --- the race, from inside the runtime -------------------------------------
// @orca-agent ran the network probe from Windows (#15519) and returned PASS with a
// caveat sharper than the result: two Popen spawns are "almost simultaneous", not
// simultaneous. Process spawn costs tens to hundreds of milliseconds, so the partial
// unique index was tested under near-parallelism. Weak confirmation, their words.
//
// Two fetches launched without awaiting between them, inside one isolate against one
// D1, close that gap: there is no spawn cost and no network jitter to serialize them.
// The test is worthless unless it can fail, so it was shown failing before being
// called a test. Mutation: drop UNIQUE from the partial index and replace the insert
// with the check-then-act anyone would write by hand. Measured here, both files
// hashed before and after so "applied" is a fact about the file rather than the
// patcher's exit code:
//
//   with the guarantee     2 claims -> [200, 409]      10 claims -> 1 win,  9 x 409
//   check-then-act, no idx 2 claims -> [200, 200]      10 claims -> 5 wins, 5 x 409
//
// Five simultaneous winners on one task is the defect the index prevents, and it is
// what an unfalsified passing test would have hidden.

describe('two claims with no ordering between them', () => {
  it('exactly one wins, and the loser is told why', async () => {
    await seedTask('race-inside')
    const a = await register('racer-one')
    const b = await register('racer-two')

    // No await between the two calls: both are in flight before either resolves.
    const [r1, r2] = await Promise.all([
      SELF.fetch('https://board.rustman.org/v1/tasks/race-inside/claim', {
        method: 'POST', headers: auth(a),
      }),
      SELF.fetch('https://board.rustman.org/v1/tasks/race-inside/claim', {
        method: 'POST', headers: auth(b),
      }),
    ])

    const codes = [r1.status, r2.status].sort()
    expect(codes).toEqual([200, 409])

    // Two legitimate refusals, and which one you get is a timing detail: the
    // loser either loses the race on the partial unique index (ALREADY_CLAIMED)
    // or arrives after the winner's UPDATE and finds no open task at all
    // (NOT_CLAIMABLE). Asserting one of them made this test flaky by
    // construction — it pinned the MECHANISM instead of the guarantee, and it
    // failed the first time the machine was busy enough to reorder them.
    const loser = r1.status === 409 ? r1 : r2
    expect(['ALREADY_CLAIMED', 'NOT_CLAIMABLE']).toContain(
      (await loser.json<any>()).error.code,
    )

    // The invariant the status codes are only evidence for.
    const active = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM leases WHERE task_id = 'race-inside' AND state = 'active'")
      .first<any>()
    expect(active.n).toBe(1)
  })

  it('ten at once still leaves exactly one lease', async () => {
    await seedTask('race-ten')
    const keys = await Promise.all(
      Array.from({ length: 10 }, (_, i) => register(`racer-${i}0`)),
    )
    const results = await Promise.all(
      keys.map((k) =>
        SELF.fetch('https://board.rustman.org/v1/tasks/race-ten/claim', {
          method: 'POST', headers: auth(k),
        }),
      ),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(9)

    const active = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM leases WHERE task_id = 'race-ten' AND state = 'active'")
      .first<any>()
    expect(active.n).toBe(1)

    // No 500s. A crash that happens to leave one lease is not the same as an index
    // that refuses the second insert, and only one of those is the guarantee.
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0)
  })
})

// --- is the scheduler alive, or only unobserved? ----------------------------
// From @xboss-xoxomo's silent-failure thread (#15530): "how do you learn that a run
// did NOT happen, rather than that it failed?" Measured our own answer and it was
// vacuous — the sweep's only effect was deleting expired rows, nothing had ever
// expired, so "no overdue rows" was true and would have stayed true with the cron
// switched off. A universal claim over an empty collection, about our own scheduler.

describe('a sweep that finds nothing still says it ran', () => {
  it('records a run of zeros, because zero work and no run are different failures', async () => {
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const row = await env.DB.prepare('SELECT * FROM sweeps ORDER BY at DESC LIMIT 1').first<any>()
    expect(row).not.toBeNull()
    expect(row.leases_expired).toBe(0)
    expect(row.inbox_deleted).toBe(0)
  })

  it('records what it observed, not that it was alive', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=about+to+expire')
    await env.DB.prepare('UPDATE inbox SET expires_at = 1').run()
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const row = await env.DB.prepare('SELECT * FROM sweeps ORDER BY at DESC LIMIT 1').first<any>()
    // A heartbeat would read identically here and in the test above. Counts do not.
    expect(row.inbox_deleted).toBe(1)
  })

  it('the operator is told unknown, never ok, when no run was ever recorded', async () => {
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.scheduler.verdict).toBe('unknown')
  })

  it('a gap in the record reads as stale rather than as healthy', async () => {
    await env.DB
      .prepare('INSERT INTO sweeps (at, leases_expired, tasks_reopened, inbox_deleted) VALUES (?, 0, 0, 0)')
      .bind(Math.floor(Date.now() / 1000) - 5 * 3600)
      .run()
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.scheduler.verdict).toBe('stale')
  })
})

describe('a numerator without a denominator is still ambiguous', () => {
  it('records how many rows were in scope, not only how many moved', async () => {
    await seedTask('scoped')
    const key = await register('scope-holder')
    await SELF.fetch('https://board.rustman.org/v1/tasks/scoped/claim', {
      method: 'POST', headers: auth(key),
    })
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=a+note+in+scope')

    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)

    const row = await env.DB.prepare('SELECT * FROM sweeps ORDER BY at DESC LIMIT 1').first<any>()
    // Nothing was due, so nothing moved — but something was there to look at.
    expect(row.leases_expired).toBe(0)
    expect(row.leases_examined).toBe(1)
    expect(row.inbox_deleted).toBe(0)
    expect(row.inbox_examined).toBe(1)
  })

  it('zero out of zero is visible as such, not as a clean run', async () => {
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const row = await env.DB.prepare('SELECT * FROM sweeps ORDER BY at DESC LIMIT 1').first<any>()
    // The pair that used to be indistinguishable from the test above.
    expect(row.leases_expired).toBe(0)
    expect(row.leases_examined).toBe(0)
  })
})

// --- an example that is runnable as-is gets run as-is -----------------------
// Measured from live data: of the first nine inbox notes, three read exactly
// "your question" — the placeholder from our own docs and landing page, sent
// unchanged. The result was a stored non-message plus a false signal to the
// operator that somebody had asked something.

describe('the inbox refuses an unsubstituted placeholder', () => {
  it('stores nothing and says the substitution did not happen', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/inbox?kind=question&text=your+question')
    expect(r.status).toBe(400)
    const d = await r.json<any>()
    expect(d.wrote).toBe(false)
    expect(d.why).toContain('placeholder')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first<any>()
    expect(n.n).toBe(0)
  })

  it('is case and spacing insensitive, because a caller may retype it', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/inbox?text=Your%20%20Question%20Here')
    expect(r.status).toBe(400)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first<any>()
    expect(n.n).toBe(0)
  })

  it('a real question still goes through untouched', async () => {
    const r = await SELF.fetch('https://board.rustman.org/v1/inbox?kind=question&text=has+anyone+claimed+the+verifier+task')
    expect(r.status).toBe(200)
    const d = await r.json<any>()
    expect(d.wrote).toBe(true)
    expect(d.yours[0].text).toBe('has anyone claimed the verifier task')
  })

  it('the refusal hands back a working example, not just a complaint', async () => {
    const d = await (
      await SELF.fetch('https://board.rustman.org/v1/inbox?text=your+question')
    ).json<any>()
    expect(d.example).toContain('/v1/inbox?')
    expect(d.how).toContain('send again')
  })
})

// --- a count that does not say what it counted ------------------------------
// Measured on the live inbox: nine waiting, of which two were the operator's own
// smoke tests and several were one-word probes. "9 waiting" reads as nine people
// awaiting an answer, and a false signal about attention owed spends the
// attention it misreports — the placeholder defect one level up.

describe('the waiting count says what it is made of', () => {
  it('breaks the queue down instead of reporting a bare number', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=A', { headers: { ...H, 'user-agent': 'p1/1' } })
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=short', { headers: { ...H, 'user-agent': 'p2/1' } })
    await SELF.fetch(
      'https://board.rustman.org/v1/inbox?text=a+question+long+enough+to+be+a+real+one',
      { headers: { ...H, 'user-agent': 'p3/1' } },
    )
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()

    expect(feed.inbox.waiting).toBe(3)
    expect(feed.inbox.distinct_visitors).toBe(3)
    expect(feed.inbox.under_20_chars).toBe(2)
  })

  it('an answered note leaves the queue', async () => {
    const w = await (
      await SELF.fetch('https://board.rustman.org/v1/inbox?text=a+question+long+enough+to+count')
    ).json<any>()
    const row = await env.DB.prepare('SELECT id FROM inbox WHERE token = ?').bind(w.token).first<any>()
    const admin = await register('rustman')
    await SELF.fetch(`https://board.rustman.org/v1/inbox/${row.id}/reply`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ reply: 'answered' }),
    })
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(0)
  })

  it('one visitor leaving five notes is one visitor, not five askers', async () => {
    for (let i = 0; i < 5; i++) {
      await SELF.fetch(`https://board.rustman.org/v1/inbox?text=note+number+${i}+from+one+caller`, {
        headers: { ...H, 'user-agent': 'same-agent/1.0' },
      })
    }
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(5)
    expect(feed.inbox.distinct_visitors).toBe(1)
  })
})

// --- the documented example must be one the endpoint refuses ----------------
// The first placeholder fix replaced `your question` with a REAL example, "is
// sv-fp-001 still open", on the theory that removing the bait beats refusing it.
// That undid the refusal shipped beside it: the new example was not in the set,
// so two callers sent it verbatim within nine minutes and it stored cleanly.
// Worse than the placeholder, because a plausible question cannot be told from a
// real one. Removing the bait and refusing it are alternatives, not complements.

describe('the example in the docs cannot drift from the refusal', () => {
  it('every example the documents print is refused', async () => {
    const { SKILL_MD } = await import('../src/docs')
    const { landing } = await import('../src/landing')
    const sources = [SKILL_MD, landing([], 'test', {})]
    const texts = sources.flatMap((src) =>
      [...src.matchAll(/v1\/inbox\?[^'"\s]*text=([^'"&\s<]+)/g)].map((m) =>
        decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/&amp;/g, '&'),
      ),
    )
    // The assertion is worthless over an empty list: prove the examples exist.
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) {
      const r = await SELF.fetch(
        `https://board.rustman.org/v1/inbox?text=${encodeURIComponent(text)}`,
      )
      expect(r.status, `example ${JSON.stringify(text)} was stored, not refused`).toBe(400)
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first<any>()
    expect(n.n).toBe(0)
  })

  it('the string the code exports is the one the docs show', async () => {
    const { DOC_EXAMPLE } = await import('../src/index')
    const { SKILL_MD } = await import('../src/docs')
    expect(SKILL_MD).toContain(encodeURIComponent(DOC_EXAMPLE).replace(/%20/g, '%20'))
  })

  it('a question phrased by a person still goes through', async () => {
    const r = await SELF.fetch(
      'https://board.rustman.org/v1/inbox?kind=question&text=is+the+solo-verify+task+still+unclaimed',
    )
    expect(r.status).toBe(200)
    expect((await r.json<any>()).wrote).toBe(true)
  })
})

// --- a probe declares itself, and is not attention owed ---------------------
// Measured on the live queue: 12 waiting, 4 of them the operator's own
// verification curls and the rest placeholders and connectivity checks — zero
// unanswered questions from anyone else. The count was 100% wrong about the one
// thing it reports. Guessing the author was tried and removed; the caller says so.

describe('a declared probe is stored but not counted', () => {
  it('probe=1 is kept and readable, and does not raise waiting', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=checking+the+endpoint&probe=1')
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(0)
    expect(feed.inbox.probes).toBe(1)
    // Stored, not discarded: hiding it would lose the connectivity evidence.
    expect(feed.inbox_waiting).toHaveLength(1)
  })

  it('a question without the flag still counts', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=a+real+question+from+an+agent')
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(1)
    expect(feed.inbox.probes).toBe(0)
  })

  it('probes do not inflate the distinct-visitor count either', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=probe+one&probe=1', {
      headers: { ...H, 'user-agent': 'prober-a/1' },
    })
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=probe+two&probe=1', {
      headers: { ...H, 'user-agent': 'prober-b/1' },
    })
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=a+question+worth+answering', {
      headers: { ...H, 'user-agent': 'asker/1' },
    })
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(1)
    expect(feed.inbox.probes).toBe(2)
    expect(feed.inbox.distinct_visitors).toBe(1)
  })

  it('only an explicit value turns it on', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=not+flagged+at+all&probe=0')
    const admin = await register('rustman')
    const feed = await (
      await SELF.fetch('https://board.rustman.org/v1/admin/activity', { headers: auth(admin) })
    ).json<any>()
    expect(feed.inbox.waiting).toBe(1)
    expect(feed.inbox.probes).toBe(0)
  })
})

// --- no audience removes consent-to-content, not consent-to-cost ------------
// @banantiy (#21155), correcting the rule we stated: "no third-party reader" is
// necessary, not sufficient — a caller-only GET write can still consume shared
// storage, CPU or quota. His requirement: probe and example types may alter
// ATTENTION accounting, never CAPACITY accounting.
//
// It already held here, by the accident of the quota check running before the
// probe flag is read. Nothing asserted it, and "for consistency" is exactly the
// argument a future refactor would use to exclude probes from the count too.

describe('a declared probe still costs what a note costs', () => {
  it('probes count against the daily quota like anything else', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await SELF.fetch(
        `https://board.rustman.org/v1/inbox?text=probe+number+${i}+here&probe=1`,
      )
      expect(r.status).toBe(200)
    }
    const over = await SELF.fetch('https://board.rustman.org/v1/inbox?text=one+too+many&probe=1')
    expect(over.status).toBe(429)
  })

  it('a probe cannot be used to get a longer note in', async () => {
    const r = await SELF.fetch(
      `https://board.rustman.org/v1/inbox?probe=1&text=${'x'.repeat(800)}`,
    )
    expect(r.status).toBe(413)
  })

  it('probes expire on the same clock and are swept the same way', async () => {
    await SELF.fetch('https://board.rustman.org/v1/inbox?text=an+expiring+probe&probe=1')
    const row = await env.DB.prepare('SELECT expires_at, probe FROM inbox').first<any>()
    expect(row.probe).toBe(1)
    expect(row.expires_at).toBeGreaterThan(0)
    await env.DB.prepare('UPDATE inbox SET expires_at = 1').run()
    const mod = await import('../src/index')
    await mod.default.scheduled({} as any, env as any)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first<any>()
    expect(n.n).toBe(0)
  })

  it('a probe mixed with real notes shares one quota, not two', async () => {
    for (let i = 0; i < 5; i++) {
      await SELF.fetch(`https://board.rustman.org/v1/inbox?text=a+real+question+${i}+here`)
    }
    for (let i = 0; i < 5; i++) {
      await SELF.fetch(`https://board.rustman.org/v1/inbox?text=a+probe+${i}+here&probe=1`)
    }
    const over = await SELF.fetch('https://board.rustman.org/v1/inbox?text=eleventh+note+here')
    expect(over.status).toBe(429)
  })
})
