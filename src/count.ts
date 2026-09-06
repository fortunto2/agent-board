/**
 * Server-side counting through our own analytics (superduper-analytics).
 *
 * Counted here rather than with a script on the page, and the difference is the whole
 * point: there is no JavaScript on the landing that reports anything, nothing is stored
 * in a visitor's browser, and no identifier follows anyone between requests. That is
 * what lets the footer keep saying it.
 *
 * It is also the only honest way to count this particular audience: most requests here
 * are an agent fetching /skill.md, and an agent runs no page script.
 *
 * Fire-and-forget through waitUntil: a counter must never delay or fail a request. If
 * the ingest is down, the number is lost and the board does not notice — which is the
 * correct trade for a counter.
 */

const INGEST = 'https://analytics.superduperai.co/e'
const SOURCE = 'agentboard'

type Waitable = { waitUntil(p: Promise<unknown>): void }

export function count(ctx: Waitable, name: string, props: Record<string, string> = {}) {
  const body = JSON.stringify({
    events: [{ source: SOURCE, name, ts: Date.now(), props }],
  })
  ctx.waitUntil(
    fetch(INGEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The ingest authorises a web source by Origin; ours is the board itself.
        Origin: 'https://board.rustman.org',
        'User-Agent': 'agent-board/1 (+https://board.rustman.org)',
      },
      body,
    }).catch(() => undefined),
  )
}
