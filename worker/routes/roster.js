import { Hono } from 'hono'
import { loadLeague, requireTeam, requireUser } from '../middleware/auth.js'
import {
  getTeamRoster,
  setLineup,
  addFreeAgent,
  dropPlayer,
  ensureLineupRows,
  placeOnIr,
  activateFromIr,
  swapIr,
  isIrEligible,
} from '../services/roster.js'
import { getLockState } from '../services/locks.js'
import { renameTeam, setTradeBlock, getTradeBlock } from '../services/team.js'
import { searchPlayers, getPlayerWithAvailability, setWatchlist } from '../services/players.js'
import { getWeekProjections } from '../services/scoring.js'

const router = new Hono()
router.use('*', loadLeague)

/** Player pool search, with watchlist state and next week's projected points. */
router.get('/players', async (c) => {
  const league = c.get('league')
  const user = c.get('user')

  const players = await searchPlayers(league.id, {
    search: c.req.query('search') || undefined,
    position: c.req.query('position') || undefined,
    availability: c.req.query('availability') || undefined,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    userId: user?.id ?? null,
    watchedOnly: c.req.query('watched') === '1',
  })

  // Projections are for the week about to be played, which during the open
  // window is the league's current week.
  const week = Number(c.req.query('week') ?? league.current_week)
  const projections = await getWeekProjections(league.season, week, league.season_type)

  return c.json({
    week,
    players: players.map((p) => ({
      ...p,
      watched: Boolean(p.watched),
      projectedPoints: projections.get(p.id) ?? null,
      // Decided here rather than in the browser so the eligible-status list
      // stays in config and can't drift out of step with what the server
      // will actually accept.
      irEligible: isIrEligible(p),
    })),
  })
})

/** Toggle a player on the signed-in manager's watchlist. Body: { playerId, watched } */
router.post('/watchlist', requireUser, async (c) => {
  const league = c.get('league')
  const { playerId, watched } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  return c.json(
    await setWatchlist({
      leagueId: league.id,
      userId: c.get('user').id,
      playerId: String(playerId),
      watched: watched !== false,
    }),
  )
})

router.get('/players/:playerId', async (c) => {
  const player = await getPlayerWithAvailability(c.get('league').id, c.req.param('playerId'))
  if (!player) return c.json({ error: 'Player not found.' }, 404)
  return c.json({ player })
})

/** The signed-in manager's roster (or any team's, with ?teamId=). */
router.get('/roster', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const week = Number(c.req.query('week') ?? league.current_week)

  await ensureLineupRows(league.id, team.id, league.season, week)
  const lockState = await getLockState(league.id)

  return c.json({
    team: { id: team.id, name: team.name, abbreviation: team.abbreviation },
    lockState,
    roster: await getTeamRoster(league.id, team.id, league.season, week, lockState),
  })
})

/** Replace the starting lineup. Body: { week?, assignments: { QB: "4034", ... } } */
router.put('/lineup', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const body = c.get('body') || {}
  const week = Number(body.week ?? league.current_week)

  if (!body.assignments || typeof body.assignments !== 'object') {
    return c.json({ error: 'Body must include an "assignments" object.' }, 400)
  }

  const roster = await setLineup(league.id, team.id, league.season, week, body.assignments)
  return c.json({ roster, lockState: await getLockState(league.id) })
})

/** Free-agent pickup. Body: { addPlayerId, dropPlayerId? } */
router.post('/free-agents/add', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { addPlayerId, dropPlayerId = null, toIr = false } = c.get('body') || {}
  if (!addPlayerId) return c.json({ error: 'addPlayerId is required.' }, 400)

  const result = await addFreeAgent({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    addPlayerId: String(addPlayerId),
    dropPlayerId: dropPlayerId ? String(dropPlayerId) : null,
    toIr: toIr === true,
  })

  return c.json(
    { ...result, roster: await getTeamRoster(league.id, team.id, league.season, league.current_week) },
    201,
  )
})

/** Move an injured player to IR. Body: { playerId } */
router.post('/ir/place', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { playerId } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  const result = await placeOnIr({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    playerId: String(playerId),
  })

  return c.json({
    ...result,
    roster: await getTeamRoster(league.id, team.id, league.season, league.current_week),
  })
})

/** Bring a player back off IR. Body: { playerId } */
router.post('/ir/activate', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { playerId } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  const result = await activateFromIr({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    playerId: String(playerId),
  })

  return c.json({
    ...result,
    roster: await getTeamRoster(league.id, team.id, league.season, league.current_week),
  })
})

/**
 * Swap the IR slot: activate one player and place another, atomically.
 * Body: { activatePlayerId, placePlayerId }
 *
 * Exists because a full roster with a full IR would otherwise be stuck — you
 * couldn't activate without a spare spot, and couldn't make one without dropping.
 */
router.post('/ir/swap', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { activatePlayerId, placePlayerId } = c.get('body') || {}
  if (!activatePlayerId || !placePlayerId) {
    return c.json({ error: 'activatePlayerId and placePlayerId are both required.' }, 400)
  }

  const result = await swapIr({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    activatePlayerId: String(activatePlayerId),
    placePlayerId: String(placePlayerId),
  })

  return c.json({
    ...result,
    roster: await getTeamRoster(league.id, team.id, league.season, league.current_week),
  })
})

/** Drop to waivers. Body: { playerId } */
router.post('/drop', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { playerId } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  const result = await dropPlayer({
    leagueId: league.id,
    teamId: team.id,
    season: league.season,
    week: league.current_week,
    playerId: String(playerId),
  })

  return c.json({ ...result, roster: await getTeamRoster(league.id, team.id, league.season, league.current_week) })
})

/** Rename your own team. Body: { name, abbreviation? } */
router.put('/team', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { name, abbreviation = null } = c.get('body') || {}
  return c.json(
    await renameTeam({ leagueId: league.id, teamId: team.id, name, abbreviation }),
  )
})

/** Everyone the league has listed as available. */
router.get('/trade-block', requireUser, async (c) =>
  c.json({ listings: await getTradeBlock(c.get('league').id) }),
)

/** List or unlist one of your own players. Body: { playerId, listed } */
router.post('/trade-block', requireTeam, async (c) => {
  const league = c.get('league')
  const team = c.get('team')
  const { playerId, listed } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  const result = await setTradeBlock({
    leagueId: league.id,
    teamId: team.id,
    playerId: String(playerId),
    listed: listed === true,
  })
  return c.json({ ...result, listings: await getTradeBlock(league.id) })
})

export default router
