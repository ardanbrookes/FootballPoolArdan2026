/**
 * Commissioner console.
 *
 * League-scoped and gated on a signed-in commissioner, unlike /api/admin which
 * is mostly token-gated. The distinction is deliberate: everything here is a
 * routine in-season correction the commissioner should be able to make from
 * their phone, not an operation that can destroy the league.
 */

import { Hono } from 'hono'
import { loadLeague, requireUser, requireCommissioner } from '../middleware/auth.js'
import {
  movePlayer,
  setIrFlag,
  setPoolStatus,
  setMatchupScore,
  clearMatchupOverride,
  recalculateWeek,
  undoTransaction,
  reverseTrade,
  setCurrentWeek,
  listUndoableTransactions,
  listReversibleTrades,
  listAllRosters,
  listMatchupsForWeek,
} from '../services/commissioner.js'
import { setLineup } from '../services/roster.js'

const router = new Hono()
router.use('*', loadLeague, requireUser, requireCommissioner)

/** Everything the console needs to render in one round trip. */
router.get('/overview', async (c) => {
  const league = c.get('league')
  const week = Number(c.req.query('week') ?? league.current_week)

  const [rosters, transactions, trades, matchups] = await Promise.all([
    listAllRosters(league.id),
    listUndoableTransactions(league.id, 40),
    listReversibleTrades(league.id, 25),
    listMatchupsForWeek(league.id, league.season, week),
  ])

  return c.json({
    league: { id: league.id, season: league.season, currentWeek: league.current_week },
    week,
    rosters,
    transactions,
    trades,
    matchups,
  })
})

/** Move a player. Body: { playerId, toTeamId (null = free agency), toIr?, note? } */
router.post('/roster/move', async (c) => {
  const league = c.get('league')
  const { playerId, toTeamId = null, toIr = false, note = null } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)

  return c.json(
    await movePlayer({
      leagueId: league.id,
      league,
      playerId: String(playerId),
      toTeamId: toTeamId ? Number(toTeamId) : null,
      toIr: toIr === true,
      note: note ? String(note).slice(0, 200) : null,
    }),
  )
})

/** Toggle a rostered player's IR flag. Body: { playerId, onIr } */
router.post('/roster/ir', async (c) => {
  const { playerId, onIr } = c.get('body') || {}
  if (!playerId) return c.json({ error: 'playerId is required.' }, 400)
  return c.json(await setIrFlag({ leagueId: c.get('league').id, playerId: String(playerId), onIr: onIr === true }))
})

/** Overwrite any team's lineup, ignoring locks. Body: { teamId, week?, assignments } */
router.put('/roster/lineup', async (c) => {
  const league = c.get('league')
  const { teamId, week, assignments } = c.get('body') || {}
  if (!teamId) return c.json({ error: 'teamId is required.' }, 400)
  if (!assignments || typeof assignments !== 'object') {
    return c.json({ error: 'Body must include an "assignments" object.' }, 400)
  }

  const roster = await setLineup(
    league.id,
    Number(teamId),
    league.season,
    Number(week ?? league.current_week),
    assignments,
    { bypassLocks: true },
  )
  return c.json({ roster })
})

/** Force availability. Body: { playerId, status: 'free_agent' | 'waivers', clearAt? } */
router.post('/pool/status', async (c) => {
  const { playerId, status, clearAt = null } = c.get('body') || {}
  if (!playerId || !status) return c.json({ error: 'playerId and status are required.' }, 400)
  return c.json(
    await setPoolStatus({
      leagueId: c.get('league').id,
      playerId: String(playerId),
      status: String(status),
      clearAt,
    }),
  )
})

/** Set a score by hand. Body: { matchupId, homeScore, awayScore, status? } */
router.post('/scores', async (c) => {
  const league = c.get('league')
  const { matchupId, homeScore, awayScore, status = null } = c.get('body') || {}
  if (!matchupId) return c.json({ error: 'matchupId is required.' }, 400)

  return c.json(
    await setMatchupScore({
      leagueId: league.id,
      league,
      matchupId: Number(matchupId),
      homeScore: Number(homeScore),
      awayScore: Number(awayScore),
      status: status ? String(status) : null,
    }),
  )
})

/** Give a matchup back to automatic scoring. Body: { matchupId } */
router.post('/scores/clear', async (c) => {
  const league = c.get('league')
  const { matchupId } = c.get('body') || {}
  if (!matchupId) return c.json({ error: 'matchupId is required.' }, 400)
  return c.json(await clearMatchupOverride({ leagueId: league.id, league, matchupId: Number(matchupId) }))
})

/** Rescore a whole week from the stat lines. Body: { week?, markFinal? } */
router.post('/scores/recalculate', async (c) => {
  const league = c.get('league')
  const { week, markFinal = false } = c.get('body') || {}
  return c.json(
    await recalculateWeek({
      leagueId: league.id,
      league,
      week: Number(week ?? league.current_week),
      markFinal: markFinal === true,
    }),
  )
})

/** Reverse a signing, drop or waiver award. Body: { transactionId } */
router.post('/undo/transaction', async (c) => {
  const league = c.get('league')
  const { transactionId } = c.get('body') || {}
  if (!transactionId) return c.json({ error: 'transactionId is required.' }, 400)
  return c.json(
    await undoTransaction({ leagueId: league.id, league, transactionId: Number(transactionId) }),
  )
})

/** Reverse an accepted trade. Body: { tradeId } */
router.post('/undo/trade', async (c) => {
  const league = c.get('league')
  const { tradeId } = c.get('body') || {}
  if (!tradeId) return c.json({ error: 'tradeId is required.' }, 400)
  return c.json(await reverseTrade({ leagueId: league.id, league, tradeId: Number(tradeId) }))
})

/** Move the league to a different week. Body: { week } */
router.post('/week', async (c) => {
  const league = c.get('league')
  const { week } = c.get('body') || {}
  return c.json(await setCurrentWeek({ leagueId: league.id, league, week: Number(week) }))
})

export default router
