import { Hono } from 'hono'
import { get } from '../db.js'
import { loadLeague, requireTeam, requireUser, requireCommissioner } from '../middleware/auth.js'
import {
  submitClaim,
  cancelClaim,
  reorderClaims,
  getPendingClaims,
  getWaiverResults,
  getWaiverOrder,
  processWaivers,
} from '../services/waivers.js'
import { getLockState } from '../services/locks.js'
import { runWaiverProcessing } from '../jobs/weekly.js'

const router = new Hono()
router.use('*', loadLeague)

/** Priority order for the whole league. */
router.get('/order', async (c) => c.json({ order: await getWaiverOrder(c.get('league').id) }))

/** Pending claims — all teams', or just yours with ?mine=1. */
router.get('/claims', requireUser, async (c) => {
  const league = c.get('league')
  const mine = c.req.query('mine') === '1' || c.req.query('mine') === 'true'
  if (!mine) return c.json({ claims: await getPendingClaims(league.id) })

  const team = await get('SELECT id FROM teams WHERE user_id = @userId AND league_id = @leagueId', {
    userId: c.get('user').id,
    leagueId: league.id,
  })
  if (!team) return c.json({ claims: [] })
  return c.json({ claims: await getPendingClaims(league.id, team.id) })
})

/** Processed claims feed. */
router.get('/results', async (c) =>
  c.json({
    results: await getWaiverResults(c.get('league').id, {
      season: c.req.query('season') ? Number(c.req.query('season')) : undefined,
      week: c.req.query('week') ? Number(c.req.query('week')) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    }),
  }),
)

/** Submit a claim. Body: { addPlayerId, dropPlayerId?, priority? } */
router.post('/claims', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { addPlayerId, dropPlayerId = null, priority, toIr = false } = c.get('body') || {}
  if (!addPlayerId) return c.json({ error: 'addPlayerId is required.' }, 400)

  const claim = await submitClaim({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    addPlayerId: String(addPlayerId),
    dropPlayerId: dropPlayerId ? String(dropPlayerId) : null,
    priority: priority ? Number(priority) : undefined,
    toIr: toIr === true,
  })

  return c.json({ claim, claims: await getPendingClaims(league.id, team.id) }, 201)
})

router.delete('/claims/:claimId', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  await cancelClaim({ leagueId: league.id, teamId: team.id, claimId: Number(c.req.param('claimId')) })
  return c.json({ claims: await getPendingClaims(league.id, team.id) })
})

/** Reorder your queue. Body: { claimIds: [3, 1, 2] } — most wanted first. */
router.put('/claims/order', requireTeam, async (c) => {
  const { claimIds } = c.get('body') || {}
  if (!Array.isArray(claimIds)) return c.json({ error: 'claimIds must be an array.' }, 400)

  return c.json({
    claims: await reorderClaims({
      leagueId: c.get('league').id,
      teamId: c.get('team').id,
      claimIds: claimIds.map(Number),
    }),
  })
})

/**
 * Preview what the next run would do, without changing anything.
 * Handy for explaining the priority system to the league.
 */
router.get('/preview', requireUser, async (c) => c.json(await processWaivers(c.get('league').id, { dryRun: true })))

/** Commissioner: run waivers now instead of waiting for the cron. */
router.post('/process', requireUser, requireCommissioner, async (c) => {
  const league = c.get('league')
  const [result] = await runWaiverProcessing({ leagueId: league.id })
  return c.json({ result, lockState: await getLockState(league.id) })
})

export default router
