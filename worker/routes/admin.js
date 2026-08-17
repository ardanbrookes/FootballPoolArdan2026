/**
 * Operational endpoints, guarded by the ADMIN_TOKEN secret.
 *
 * These exist because Workers have no CLI process that can hold a D1 binding —
 * anything that would have been an `npm run` script in a Node deployment has to
 * be reachable over HTTP instead. Call them with `x-admin-token: <token>`.
 */

import { Hono } from 'hono'
import { requireAdminToken, requireAdminOrCommissioner } from '../middleware/auth.js'
import { seedLeague } from '../seed.js'
import { runTick } from '../jobs/tick.js'
import { runWaiverProcessing, runWeekReset, runStatsRefresh, runDailySync } from '../jobs/weekly.js'
import { syncPlayers, getSyncLog } from '../services/sleeper.js'
import { importSleeperLeague } from '../services/sleeper-import.js'
import { syncSeason } from '../services/schedule.js'
import { get, query } from '../db.js'

const router = new Hono()

// Routine operations: signed-in commissioner is enough.
router.use('/tick', requireAdminOrCommissioner)
router.use('/waivers/*', requireAdminOrCommissioner)
router.use('/week-reset', requireAdminOrCommissioner)
router.use('/stats-refresh', requireAdminOrCommissioner)
router.use('/sync/*', requireAdminOrCommissioner)
router.use('/status', requireAdminOrCommissioner)

// Seeding is token-only: it has to work before any user exists, and with
// ?force=1 it wipes the league.
router.use('/seed', requireAdminToken)
// A committed import replaces every roster in the league, so it needs the token
// rather than just a commissioner session — same bar as seeding.
router.use('/import/*', requireAdminToken)

/** Build the demo league. Pass ?force=1 to wipe an existing one first. */
router.post('/seed', async (c) => {
  const force = c.req.query('force') === '1' || c.req.query('force') === 'true'
  const logs = []
  const result = await seedLeague({ force, log: (line) => logs.push(line) })
  return c.json({ ...result, logs })
})

/** Run the cron dispatcher by hand. ?job=waivers|week-reset|stats|daily-sync forces one. */
router.post('/tick', async (c) => c.json(await runTick({ force: c.req.query('job') || null })))

router.post('/waivers/process', async (c) =>
  c.json({ results: await runWaiverProcessing({ leagueId: numberOrNull(c.req.query('leagueId')) }) }),
)

router.post('/week-reset', async (c) =>
  c.json({ results: await runWeekReset({ leagueId: numberOrNull(c.req.query('leagueId')) }) }),
)

router.post('/stats-refresh', async (c) =>
  c.json({ results: await runStatsRefresh({ leagueId: numberOrNull(c.req.query('leagueId')) }) }),
)

router.post('/sync/players', async (c) =>
  c.json(await syncPlayers({ force: c.req.query('force') !== '0' })),
)

router.post('/sync/schedule', async (c) => {
  const leagues = await query('SELECT DISTINCT season, season_type FROM leagues')
  const results = []
  for (const league of leagues) {
    results.push(await syncSeason(league.season, { seasonType: league.season_type, fromWeek: 1, toWeek: 18 }))
  }
  return c.json({ results })
})

router.post('/sync/daily', async (c) => c.json(await runDailySync()))

/**
 * Import a drafted Sleeper league.
 *
 * Body: {
 *   sleeperLeagueId, leagueId?, managerMap?, importTeamNames?, commit?
 * }
 *
 * Defaults to a dry run. `commit: true` REPLACES every roster in the league, so
 * it sits behind the admin token rather than a commissioner session.
 */
router.post('/import/sleeper', async (c) => {
  const body = c.get('body') || {}
  const sleeperLeagueId = String(body.sleeperLeagueId || '').trim()

  // `payload` lets the import be exercised against a fixture instead of the live
  // Sleeper API — the only way to test the mapping before a real draft exists.
  if (!sleeperLeagueId && !body.payload) {
    return c.json({ error: 'sleeperLeagueId is required (it is in your Sleeper league URL).' }, 400)
  }

  const league =
    (await get('SELECT id FROM leagues WHERE id = @id', { id: Number(body.leagueId) || 0 })) ||
    (await get('SELECT id FROM leagues ORDER BY id ASC LIMIT 1'))
  if (!league) return c.json({ error: 'No league exists to import into.' }, 404)

  return c.json(
    await importSleeperLeague({
      leagueId: league.id,
      sleeperLeagueId,
      managerMap: body.managerMap || {},
      importTeamNames: Boolean(body.importTeamNames),
      commit: body.commit === true,
      payload: body.payload || null,
    }),
  )
})

router.get('/status', async (c) =>
  c.json({
    leagues: await query('SELECT id, name, season, current_week FROM leagues'),
    syncs: await getSyncLog(),
  }),
)

function numberOrNull(value) {
  return value ? Number(value) : null
}

export default router
