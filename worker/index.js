/**
 * Worker entry point.
 *
 * `fetch`     serves /api/*. Static assets are handled by Cloudflare before the
 *             Worker runs (see [assets] in wrangler.toml), with the SPA fallback
 *             for client-side routes.
 * `scheduled` runs the cron dispatcher — see jobs/tick.js for why it ticks
 *             frequently instead of encoding the deadlines directly.
 */

import { Hono } from 'hono'
import { withContext } from './context.js'
import { attachUser, parseBody } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import leagueRoutes from './routes/league.js'
import rosterRoutes from './routes/roster.js'
import waiverRoutes from './routes/waivers.js'
import tradeRoutes from './routes/trades.js'
import chatRoutes from './routes/chat.js'
import newsRoutes from './routes/news.js'
import adminRoutes from './routes/admin.js'
import { runTick } from './jobs/tick.js'
import { getSyncLog } from './services/sleeper.js'

const app = new Hono().basePath('/api')

app.use('*', parseBody)
app.use('*', attachUser)

app.get('/health', async (c) => c.json({ ok: true, syncs: await getSyncLog() }))

app.route('/auth', authRoutes)
app.route('/admin', adminRoutes)

// Routes are league-scoped. `/api/league/...` resolves the caller's league so
// the single-league case stays tidy; `/api/leagues/:leagueId/...` is explicit.
for (const prefix of ['/league', '/leagues/:leagueId']) {
  app.route(prefix, leagueRoutes)
  app.route(prefix, rosterRoutes)
  app.route(`${prefix}/waivers`, waiverRoutes)
  app.route(`${prefix}/trades`, tradeRoutes)
  app.route(`${prefix}/chat`, chatRoutes)
  app.route(`${prefix}/news`, newsRoutes)
}

app.notFound((c) => c.json({ error: 'Not found.' }, 404))

// Services throw errors carrying `status` and `code`; anything else is a 500.
app.onError((err, c) => {
  const status = err.status || 500
  if (status >= 500) console.error('[worker]', err)
  return c.json({ error: err.message || 'Something went wrong.', code: err.code }, status)
})

export default {
  fetch(request, env, ctx) {
    return withContext(env, () => app.fetch(request, env, ctx))
  },

  scheduled(event, env, ctx) {
    ctx.waitUntil(
      withContext(env, async () => {
        const started = Date.now()
        try {
          const result = await runTick()
          console.log(`[cron] tick finished in ${Date.now() - started}ms:`, JSON.stringify(result.ran))
        } catch (err) {
          console.error('[cron] tick failed:', err)
        }
      }),
    )
  },
}
