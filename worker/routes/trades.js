import { Hono } from 'hono'
import { get } from '../db.js'
import { loadLeague, requireTeam, requireUser } from '../middleware/auth.js'
import { proposeTrade, respondToTrade, cancelTrade, listTrades, getTrade } from '../services/trades.js'

const router = new Hono()
router.use('*', loadLeague)

/** Recent trades. ?mine=1 limits to yours, ?status=pending|accepted|rejected. */
router.get('/', requireUser, async (c) => {
  const league = c.get('league')
  const status = c.req.query('status') || undefined
  const mine = c.req.query('mine') === '1' || c.req.query('mine') === 'true'

  if (!mine) return c.json({ trades: await listTrades(league.id, { status }) })

  const team = await get('SELECT id FROM teams WHERE user_id = @userId AND league_id = @leagueId', {
    userId: c.get('user').id,
    leagueId: league.id,
  })
  if (!team) return c.json({ trades: [] })
  return c.json({ trades: await listTrades(league.id, { teamId: team.id, status }) })
})

router.get('/:tradeId', requireUser, async (c) => {
  const trade = await getTrade(Number(c.req.param('tradeId')))
  if (!trade || trade.league_id !== c.get('league').id) return c.json({ error: 'Trade not found.' }, 404)
  return c.json({ trade })
})

/**
 * Offer a trade.
 * Body: { receiverTeamId, give: [playerId], receive: [playerId], message? }
 */
router.post('/', requireTeam, async (c) => {
  const league = c.get('league')
  const {
    receiverTeamId,
    give = [],
    receive = [],
    // [{ season, round, originalTeamId? }] — recorded, not enforced.
    message,
  } = c.get('body') || {}
  if (!receiverTeamId) return c.json({ error: 'receiverTeamId is required.' }, 400)

  const trade = await proposeTrade({
    leagueId: league.id,
    season: league.season,
    week: league.current_week,
    proposerTeamId: c.get('team').id,
    receiverTeamId: Number(receiverTeamId),
    give: give.map(String),
    receive: receive.map(String),
    message,
  })

  return c.json({ trade }, 201)
})

/** Accept or reject. Body: { accept: boolean, message? } */
router.post('/:tradeId/respond', requireTeam, async (c) => {
  const { accept, message } = c.get('body') || {}
  if (typeof accept !== 'boolean') return c.json({ error: 'accept must be true or false.' }, 400)

  return c.json({
    trade: await respondToTrade({
      leagueId: c.get('league').id,
      tradeId: Number(c.req.param('tradeId')),
      teamId: c.get('team').id,
      accept,
      message,
    }),
  })
})

router.post('/:tradeId/cancel', requireTeam, async (c) =>
  c.json({
    trade: await cancelTrade({
      leagueId: c.get('league').id,
      tradeId: Number(c.req.param('tradeId')),
      teamId: c.get('team').id,
    }),
  }),
)

export default router
