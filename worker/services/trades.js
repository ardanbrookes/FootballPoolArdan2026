/**
 * Trades between two teams.
 *
 * A trade is stored as a header plus one `trade_items` row per player, tagged
 * with the team giving that player up. Execution is all-or-nothing and re-checks
 * ownership and locks at accept time, because rosters move between propose and
 * accept.
 */

import { get, query, run, batch, stmt, nowIso } from '../db.js'
import { getLockState, assertAllowed, assertPlayerMovable } from './locks.js'
import { roster as rosterConfig } from '../config.js'
import { systemMessageStatement } from './chat.js'

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

function ownedBy(leagueId, teamId, playerIds) {
  if (playerIds.length === 0) return Promise.resolve([])
  const placeholders = playerIds.map((_, i) => `@p${i}`).join(',')
  const params = { leagueId, teamId }
  playerIds.forEach((id, i) => {
    params[`p${i}`] = id
  })
  return query(
    `SELECT p.* FROM roster_players rp JOIN players p ON p.id = rp.player_id
      WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id IN (${placeholders})`,
    params,
  )
}

export async function proposeTrade({
  leagueId, season, week, proposerTeamId, receiverTeamId,
  give, receive, givePicks = [], receivePicks = [], message,
}) {
  if (proposerTeamId === receiverTeamId) throw httpError("You can't trade with yourself.")
  if (!give?.length && !receive?.length && !givePicks.length && !receivePicks.length) {
    throw httpError('A trade needs at least one player or draft pick.')
  }

  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'trade', `${locks.phaseLabel} — trades are closed.`)

  const [giving, receiving] = await Promise.all([
    ownedBy(leagueId, proposerTeamId, give || []),
    ownedBy(leagueId, receiverTeamId, receive || []),
  ])
  if (giving.length !== (give || []).length) throw httpError('You no longer own one of those players.', 409)
  if (receiving.length !== (receive || []).length) {
    throw httpError('The other team no longer owns one of those players.', 409)
  }

  for (const player of [...giving, ...receiving]) assertPlayerMovable(locks, player, 'trade')

  const result = await run(
    `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, message, season, week)
     VALUES (@leagueId, @proposerTeamId, @receiverTeamId, @message, @season, @week)`,
    { leagueId, proposerTeamId, receiverTeamId, message: message || null, season, week },
  )
  const tradeId = result.lastInsertRowid

  await batch([
    ...giving.map((player) =>
      stmt('INSERT INTO trade_items (trade_id, from_team_id, player_id) VALUES (@tradeId, @teamId, @playerId)', {
        tradeId,
        teamId: proposerTeamId,
        playerId: player.id,
      }),
    ),
    ...receiving.map((player) =>
      stmt('INSERT INTO trade_items (trade_id, from_team_id, player_id) VALUES (@tradeId, @teamId, @playerId)', {
        tradeId,
        teamId: receiverTeamId,
        playerId: player.id,
      }),
    ),
    ...pickStatements(tradeId, proposerTeamId, givePicks),
    ...pickStatements(tradeId, receiverTeamId, receivePicks),
  ])

  return getTrade(tradeId)
}

/**
 * Draft picks attached to a trade.
 *
 * Recorded only — the app never runs a draft, so nothing consumes these. They
 * exist so next season's order can be adjusted by hand against an agreed record
 * rather than someone's memory of a group chat.
 */
function pickStatements(tradeId, fromTeamId, picks) {
  return (picks || []).map((pick) =>
    stmt(
      `INSERT INTO trade_picks (trade_id, from_team_id, original_team_id, season, round)
       VALUES (@tradeId, @fromTeamId, @originalTeamId, @season, @round)`,
      {
        tradeId,
        fromTeamId,
        // Defaults to the team giving it up; set explicitly when flipping on a
        // pick acquired from someone else.
        originalTeamId: pick.originalTeamId ?? fromTeamId,
        season: Number(pick.season),
        round: Number(pick.round),
      },
    ),
  )
}

export async function getTrade(tradeId) {
  const trade = await get(
    `SELECT tr.*, pt.name AS proposer_name, pt.abbreviation AS proposer_abbr,
            rt.name AS receiver_name, rt.abbreviation AS receiver_abbr
       FROM trades tr
       JOIN teams pt ON pt.id = tr.proposer_team_id
       JOIN teams rt ON rt.id = tr.receiver_team_id
      WHERE tr.id = @tradeId`,
    { tradeId },
  )
  if (!trade) return null

  const [items, picks] = await Promise.all([
    query(
      `SELECT ti.from_team_id, p.id, p.full_name, p.position, p.nfl_team
         FROM trade_items ti JOIN players p ON p.id = ti.player_id
        WHERE ti.trade_id = @tradeId`,
      { tradeId },
    ),
    query(
      `SELECT tp.id, tp.from_team_id, tp.original_team_id, tp.season, tp.round,
              ot.abbreviation AS original_team_abbr
         FROM trade_picks tp
         LEFT JOIN teams ot ON ot.id = tp.original_team_id
        WHERE tp.trade_id = @tradeId
        ORDER BY tp.season ASC, tp.round ASC`,
      { tradeId },
    ),
  ])

  return {
    ...trade,
    proposerGives: items.filter((i) => i.from_team_id === trade.proposer_team_id),
    receiverGives: items.filter((i) => i.from_team_id === trade.receiver_team_id),
    // Draft picks carry no mechanical effect — they're recorded so next year's
    // order can be set by hand from an agreed record.
    proposerPicks: picks.filter((p) => p.from_team_id === trade.proposer_team_id),
    receiverPicks: picks.filter((p) => p.from_team_id === trade.receiver_team_id),
  }
}

export async function listTrades(leagueId, { teamId, status, limit = 50 } = {}) {
  const filters = ['tr.league_id = @leagueId']
  const params = { leagueId, limit }
  if (teamId) {
    filters.push('(tr.proposer_team_id = @teamId OR tr.receiver_team_id = @teamId)')
    params.teamId = teamId
  }
  if (status) {
    filters.push('tr.status = @status')
    params.status = status
  }

  const rows = await query(
    `SELECT tr.id FROM trades tr WHERE ${filters.join(' AND ')}
      ORDER BY tr.created_at DESC LIMIT @limit`,
    params,
  )
  return Promise.all(rows.map((r) => getTrade(r.id)))
}

export async function respondToTrade({ leagueId, tradeId, teamId, accept, message }) {
  const trade = await getTrade(tradeId)
  if (!trade || trade.league_id !== leagueId) throw httpError('Trade not found.', 404)
  if (trade.status !== 'pending') throw httpError(`This trade is already ${trade.status}.`, 409)
  if (trade.receiver_team_id !== teamId) throw httpError('Only the receiving team can respond.', 403)

  if (!accept) {
    await run(
      "UPDATE trades SET status = 'rejected', response_message = @message, resolved_at = @at WHERE id = @tradeId",
      { tradeId, message: message || null, at: nowIso() },
    )
    return getTrade(tradeId)
  }

  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'trade', `${locks.phaseLabel} — trades are closed.`)

  // Re-validate: rosters may have changed since the offer was made.
  const proposerIds = trade.proposerGives.map((p) => p.id)
  const receiverIds = trade.receiverGives.map((p) => p.id)

  const [giving, receiving] = await Promise.all([
    ownedBy(leagueId, trade.proposer_team_id, proposerIds),
    ownedBy(leagueId, trade.receiver_team_id, receiverIds),
  ])
  if (giving.length !== proposerIds.length || receiving.length !== receiverIds.length) {
    throw httpError('A player in this trade has changed hands. The offer is no longer valid.', 409)
  }
  for (const player of [...giving, ...receiving]) assertPlayerMovable(locks, player, 'trade')

  // Roster-size check after the swap.
  const countFor = async (id) =>
    (
      await get(
        'SELECT COUNT(*) AS count FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId AND on_ir = 0',
        { leagueId, teamId: id },
      )
    ).count
  const [proposerCount, receiverCount] = await Promise.all([
    countFor(trade.proposer_team_id),
    countFor(trade.receiver_team_id),
  ])
  const proposerAfter = proposerCount - proposerIds.length + receiverIds.length
  const receiverAfter = receiverCount - receiverIds.length + proposerIds.length
  if (proposerAfter > rosterConfig.maxPlayers || receiverAfter > rosterConfig.maxPlayers) {
    throw httpError(`This trade would put a roster over the ${rosterConfig.maxPlayers}-player limit.`, 409)
  }

  const moveStatements = (playerId, toTeamId, fromTeamId) => [
    stmt(
      `UPDATE roster_players SET team_id = @toTeamId, acquired_via = 'trade',
                                 acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE league_id = @leagueId AND player_id = @playerId`,
      { leagueId, playerId, toTeamId },
    ),
    // Pull the traded player out of the old team's lineup.
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @fromTeamId AND player_id = @playerId`,
      { leagueId, fromTeamId, playerId },
    ),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_team_id, season, week, notes)
       VALUES (@leagueId, @toTeamId, 'trade', 'trade', @playerId, @fromTeamId, @season, @week, @notes)`,
      {
        leagueId,
        toTeamId,
        fromTeamId,
        playerId,
        season: trade.season,
        week: trade.week,
        notes: `Trade #${tradeId}`,
      },
    ),
  ]

  // Summarise both sides for the feed, including any draft picks — those have no
  // mechanical effect but people very much want to see them announced.
  const describe = (players, picks) =>
    [...players.map((p) => p.full_name), ...picks.map((p) => `${p.season} R${p.round}`)].join(', ') ||
    'nothing'

  await batch([
    ...proposerIds.flatMap((id) => moveStatements(id, trade.receiver_team_id, trade.proposer_team_id)),
    ...receiverIds.flatMap((id) => moveStatements(id, trade.proposer_team_id, trade.receiver_team_id)),
    stmt(
      "UPDATE trades SET status = 'accepted', response_message = @message, resolved_at = @at WHERE id = @tradeId",
      { tradeId, message: message || null, at: nowIso() },
    ),
    systemMessageStatement({
      leagueId,
      teamId: trade.proposer_team_id,
      eventType: 'trade',
      body:
        `Trade completed — ${trade.proposer_name} sent ${describe(giving, trade.proposerPicks)} ` +
        `to ${trade.receiver_name} for ${describe(receiving, trade.receiverPicks)}.`,
      meta: { tradeId, proposer: trade.proposer_team_id, receiver: trade.receiver_team_id },
    }),
  ])

  return getTrade(tradeId)
}

export async function cancelTrade({ leagueId, tradeId, teamId }) {
  const trade = await get('SELECT * FROM trades WHERE id = @tradeId AND league_id = @leagueId', { tradeId, leagueId })
  if (!trade) throw httpError('Trade not found.', 404)
  if (trade.status !== 'pending') throw httpError(`This trade is already ${trade.status}.`, 409)
  if (trade.proposer_team_id !== teamId) throw httpError('Only the proposing team can cancel.', 403)

  await run("UPDATE trades SET status = 'cancelled', resolved_at = @at WHERE id = @tradeId", {
    tradeId,
    at: nowIso(),
  })
  return getTrade(tradeId)
}
