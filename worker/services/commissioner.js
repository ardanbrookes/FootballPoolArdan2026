/**
 * Commissioner tools — the manual overrides for when the league's own rules
 * produced the wrong answer.
 *
 * Three principles run through everything here:
 *
 * 1. **Locks don't apply.** Every function in this file deliberately skips the
 *    phase machine and the roster-size limits. That is the entire point: the
 *    commissioner is fixing something precisely because the normal path won't
 *    let them. Limits that are still worth knowing about come back as
 *    `warnings` rather than errors, so the caller can decide.
 *
 * 2. **Undo appends, it never erases.** Reversing a signing writes a new pair
 *    of transactions describing the reversal; it does not delete the original
 *    rows. A league where the commissioner can silently rewrite history is
 *    worse than one where mistakes are visible, and the audit trail is the
 *    thing that makes the tools trustworthy to the other seven managers.
 *
 * 3. **Everything is announced.** Each action posts to the league feed. Nobody
 *    should discover a roster change by noticing their lineup looks different.
 */

import { get, query, run, batch, stmt } from '../db.js'
import { systemMessageStatement } from './chat.js'
import { statements as poolStatements, nextWaiverClearTime } from './players.js'
import { recalculateMatchups, recalculateStandings, scoreTeamWeek } from './scoring.js'
import { ensureLineupRows } from './roster.js'
import { roster as rosterConfig } from '../config.js'

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

const COMMISH = 'commissioner'

/** Where a player currently is: a roster row, or the pool. */
async function locate(leagueId, playerId) {
  const player = await get('SELECT * FROM players WHERE id = @playerId', { playerId })
  if (!player) throw httpError('Player not found.', 404)

  const roster = await get(
    `SELECT rp.team_id, rp.on_ir, t.name AS team_name
       FROM roster_players rp JOIN teams t ON t.id = rp.team_id
      WHERE rp.league_id = @leagueId AND rp.player_id = @playerId`,
    { leagueId, playerId },
  )

  return { player, teamId: roster?.team_id ?? null, teamName: roster?.team_name ?? null, onIr: roster?.on_ir === 1 }
}

async function requireTeam(leagueId, teamId) {
  const team = await get('SELECT * FROM teams WHERE id = @teamId AND league_id = @leagueId', {
    teamId,
    leagueId,
  })
  if (!team) throw httpError('Team not found in this league.', 404)
  return team
}

function leagueWeek(league) {
  return { season: league.season, week: league.current_week }
}

/** Roster count, for the advisory warning rather than a hard limit. */
async function activeCount(leagueId, teamId) {
  const row = await get(
    'SELECT COUNT(*) AS count FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId AND on_ir = 0',
    { leagueId, teamId },
  )
  return row.count
}

// ---------------------------------------------------------------------------
// Roster editing
// ---------------------------------------------------------------------------

/**
 * Move any player anywhere: between two teams, from the pool onto a team, or
 * off a team back into the pool (`toTeamId: null`).
 *
 * One primitive rather than three endpoints, because every roster correction is
 * some version of "this player belongs somewhere else" and the three cases
 * share all of their bookkeeping — clearing the old lineup slot, fixing pool
 * state, writing the transaction pair.
 */
export async function movePlayer({ leagueId, league, playerId, toTeamId = null, toIr = false, note = null }) {
  const { season, week } = leagueWeek(league)
  const from = await locate(leagueId, playerId)
  const target = toTeamId ? await requireTeam(leagueId, toTeamId) : null

  if (from.teamId === (target?.id ?? null)) {
    throw httpError(
      target
        ? `${from.player.full_name} is already on ${target.name}.`
        : `${from.player.full_name} is already a free agent.`,
      409,
    )
  }

  const writes = []
  const warnings = []

  // Off the old roster, and out of the lineup they were filling. The lineup
  // clear is scoped to the current week only: past weeks are settled results
  // and rewriting them would change scores that have already been posted.
  if (from.teamId) {
    writes.push(
      stmt(
        `UPDATE lineups SET player_id = NULL
          WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
            AND week = @week AND player_id = @playerId`,
        { leagueId, teamId: from.teamId, season, week, playerId },
      ),
      stmt(
        `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
         VALUES (@leagueId, @teamId, 'drop', @source, @playerId, @season, @week, @notes)`,
        {
          leagueId,
          teamId: from.teamId,
          source: COMMISH,
          playerId,
          season,
          week,
          notes: note || 'Commissioner roster edit',
        },
      ),
    )
  }

  if (target) {
    if (from.teamId) {
      // Team to team: keep the single roster row and repoint it, so nothing
      // depending on the row id or acquired_at ordering is disturbed.
      writes.push(
        stmt(
          `UPDATE roster_players SET team_id = @toTeamId, acquired_via = @source, on_ir = @onIr,
                                     acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE league_id = @leagueId AND player_id = @playerId`,
          { leagueId, playerId, toTeamId: target.id, source: COMMISH, onIr: toIr ? 1 : 0 },
        ),
      )
    } else {
      writes.push(
        stmt(
          `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via, on_ir)
           VALUES (@leagueId, @teamId, @playerId, @source, @onIr)`,
          { leagueId, teamId: target.id, playerId, source: COMMISH, onIr: toIr ? 1 : 0 },
        ),
      )
    }

    writes.push(
      poolStatements.clearWaiverState(leagueId, playerId),
      stmt(
        `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_team_id, season, week, notes)
         VALUES (@leagueId, @teamId, 'add', @source, @playerId, @fromTeamId, @season, @week, @notes)`,
        {
          leagueId,
          teamId: target.id,
          source: COMMISH,
          playerId,
          fromTeamId: from.teamId,
          season,
          week,
          notes: note || 'Commissioner roster edit',
        },
      ),
    )

    if ((await activeCount(leagueId, target.id)) + (toIr ? 0 : 1) > rosterConfig.maxPlayers) {
      warnings.push(
        `${target.name} is now over the ${rosterConfig.maxPlayers}-player limit. ` +
          'Nothing enforces this retroactively — drop someone when you get a chance.',
      )
    }
  } else {
    // Back to the pool. Free agent, not waivers: a commissioner undoing a
    // mistake almost always wants the player immediately re-signable by the
    // team that should have had them, and waivers would block that for days.
    writes.push(
      stmt('DELETE FROM roster_players WHERE league_id = @leagueId AND player_id = @playerId', {
        leagueId,
        playerId,
      }),
      poolStatements.clearWaiverState(leagueId, playerId),
    )
  }

  const body = target
    ? from.teamId
      ? `Commissioner moved ${from.player.full_name} from ${from.teamName} to ${target.name}.`
      : `Commissioner placed ${from.player.full_name} on ${target.name}.`
    : `Commissioner released ${from.player.full_name} from ${from.teamName} to free agency.`

  writes.push(
    systemMessageStatement({
      leagueId,
      teamId: target?.id ?? from.teamId,
      eventType: 'commissioner',
      body: note ? `${body} (${note})` : body,
      meta: { playerId, fromTeamId: from.teamId, toTeamId: target?.id ?? null, action: 'move' },
    }),
  )

  await batch(writes)
  return { playerId, from: from.teamId, to: target?.id ?? null, warnings }
}

/** Put a team's IR occupant back on the active roster, or vice versa. */
export async function setIrFlag({ leagueId, playerId, onIr }) {
  const { player, teamId } = await locate(leagueId, playerId)
  if (!teamId) throw httpError(`${player.full_name} is not on a roster.`, 409)

  await run(
    'UPDATE roster_players SET on_ir = @onIr WHERE league_id = @leagueId AND player_id = @playerId',
    { leagueId, playerId, onIr: onIr ? 1 : 0 },
  )
  return { playerId, onIr: Boolean(onIr) }
}

// ---------------------------------------------------------------------------
// Free agent / waiver status
// ---------------------------------------------------------------------------

/**
 * Force an unrostered player's availability.
 *
 * `free_agent` clears the pool row entirely (absence of a row *is* free
 * agency); `waivers` parks them until the next processing run, or until an
 * explicit `clearAt`.
 */
export async function setPoolStatus({ leagueId, playerId, status, clearAt = null }) {
  const { player, teamId, teamName } = await locate(leagueId, playerId)
  if (teamId) {
    throw httpError(
      `${player.full_name} is on ${teamName}. Release them first — availability only applies to unrostered players.`,
      409,
    )
  }

  if (status === 'free_agent') {
    await run('DELETE FROM player_pool_state WHERE league_id = @leagueId AND player_id = @playerId', {
      leagueId,
      playerId,
    })
    return { playerId, status, clearAt: null }
  }

  if (status === 'waivers') {
    const at = clearAt || (await nextWaiverClearTime(leagueId))
    await batch([poolStatements.placeOnWaivers(leagueId, playerId, at)])
    return { playerId, status, clearAt: at }
  }

  throw httpError('status must be "free_agent" or "waivers".')
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/**
 * Set a matchup's score by hand and pin it, so the next stats refresh leaves it
 * alone. Standings are rebuilt straight away because they are derived purely
 * from final matchups.
 */
export async function setMatchupScore({ leagueId, league, matchupId, homeScore, awayScore, status = null }) {
  const matchup = await get(
    'SELECT * FROM matchups WHERE id = @matchupId AND league_id = @leagueId',
    { matchupId, leagueId },
  )
  if (!matchup) throw httpError('Matchup not found.', 404)

  for (const [label, value] of [['Home score', homeScore], ['Away score', awayScore]]) {
    if (!Number.isFinite(value)) throw httpError(`${label} must be a number.`)
  }

  const [home, away] = await Promise.all([
    get('SELECT name FROM teams WHERE id = @id', { id: matchup.home_team_id }),
    get('SELECT name FROM teams WHERE id = @id', { id: matchup.away_team_id }),
  ])

  await batch([
    stmt(
      `UPDATE matchups SET home_score = @homeScore, away_score = @awayScore,
              status = @status, manual_override = 1
        WHERE id = @matchupId`,
      {
        matchupId,
        homeScore: Math.round(homeScore * 100) / 100,
        awayScore: Math.round(awayScore * 100) / 100,
        status: status || matchup.status,
      },
    ),
    systemMessageStatement({
      leagueId,
      eventType: 'commissioner',
      body:
        `Commissioner set the week ${matchup.week} score: ` +
        `${home?.name ?? 'Home'} ${homeScore} — ${awayScore} ${away?.name ?? 'Away'}.`,
      meta: { matchupId, homeScore, awayScore, action: 'score' },
    }),
  ])

  await recalculateStandings(leagueId, league.season)
  return { matchupId, homeScore, awayScore, manualOverride: true }
}

/**
 * Hand a matchup back to automatic scoring and recompute it immediately.
 *
 * Only this matchup. Going through `recalculateMatchups` would rescore the
 * whole week and force every other game into the same status — unpinning one
 * correction would quietly mark three untouched games final and invent
 * standings from them.
 */
export async function clearMatchupOverride({ leagueId, league, matchupId }) {
  const matchup = await get(
    'SELECT * FROM matchups WHERE id = @matchupId AND league_id = @leagueId',
    { matchupId, leagueId },
  )
  if (!matchup) throw httpError('Matchup not found.', 404)

  const [home, away] = await Promise.all([
    scoreTeamWeek(leagueId, matchup.home_team_id, league.season, matchup.week),
    scoreTeamWeek(leagueId, matchup.away_team_id, league.season, matchup.week),
  ])

  await run(
    `UPDATE matchups SET manual_override = 0, home_score = @home, away_score = @away
      WHERE id = @matchupId`,
    { matchupId, home, away },
  )
  await recalculateStandings(leagueId, league.season)
  return { matchupId, manualOverride: false, homeScore: home, awayScore: away }
}

/** Force a full rescore of a week from the stat lines, then rebuild standings. */
export async function recalculateWeek({ leagueId, league, week, markFinal = false }) {
  const result = await recalculateMatchups(leagueId, league.season, week, { markFinal })
  await recalculateStandings(leagueId, league.season)
  return { week, ...result }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Reverse a signing, a drop, or a waiver award.
 *
 * Works off the transaction log, which already records the add and its paired
 * drop together (`related_player_id` on the add row). The reversal is only
 * attempted when the world still looks the way the transaction left it — if
 * the added player has since been traded on, undoing here would corrupt a
 * later, legitimate move, so it refuses and says so.
 */
export async function undoTransaction({ leagueId, league, transactionId }) {
  const tx = await get(
    `SELECT tx.*, p.full_name AS player_name, rp.full_name AS related_player_name, t.name AS team_name
       FROM transactions tx
       LEFT JOIN players p ON p.id = tx.player_id
       LEFT JOIN players rp ON rp.id = tx.related_player_id
       LEFT JOIN teams t ON t.id = tx.team_id
      WHERE tx.id = @transactionId AND tx.league_id = @leagueId`,
    { transactionId, leagueId },
  )
  if (!tx) throw httpError('Transaction not found.', 404)
  if (tx.type === 'trade') {
    throw httpError(
      'This is one leg of a trade. Reverse the whole trade instead — undoing a single player would leave the other side unbalanced.',
      409,
      'USE_TRADE_REVERSAL',
    )
  }
  if (!['add', 'drop'].includes(tx.type)) {
    throw httpError(`Nothing to undo for a "${tx.type}" transaction.`, 400)
  }

  const { season, week } = leagueWeek(league)
  const writes = []
  const summary = []

  if (tx.type === 'add') {
    const current = await locate(leagueId, tx.player_id)
    if (current.teamId !== tx.team_id) {
      throw httpError(
        current.teamId
          ? `${tx.player_name} is on ${current.teamName} now, not ${tx.team_name}. Undoing this signing would undo a later move too.`
          : `${tx.player_name} is no longer on ${tx.team_name} — this signing has already been reversed or the player was dropped.`,
        409,
        'STALE',
      )
    }

    // Where does the player go back to? A commissioner move between two teams
    // records the origin in `related_team_id`, and undoing it must send them
    // home rather than dumping them into free agency for anyone to claim.
    const origin = tx.related_team_id
      ? await get('SELECT id, name FROM teams WHERE id = @id AND league_id = @leagueId', {
          id: tx.related_team_id,
          leagueId,
        })
      : null

    writes.push(
      stmt(
        `UPDATE lineups SET player_id = NULL
          WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
            AND week = @week AND player_id = @playerId`,
        { leagueId, teamId: tx.team_id, season, week, playerId: tx.player_id },
      ),
      poolStatements.clearWaiverState(leagueId, tx.player_id),
      stmt(
        `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
         VALUES (@leagueId, @teamId, 'drop', @source, @playerId, @season, @week, @notes)`,
        {
          leagueId,
          teamId: tx.team_id,
          source: COMMISH,
          playerId: tx.player_id,
          season,
          week,
          notes: `Undo of transaction #${tx.id}`,
        },
      ),
    )

    if (origin) {
      writes.push(
        stmt(
          `UPDATE roster_players SET team_id = @toTeamId, acquired_via = @source,
                                     acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE league_id = @leagueId AND player_id = @playerId`,
          { leagueId, playerId: tx.player_id, toTeamId: origin.id, source: COMMISH },
        ),
        stmt(
          `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_team_id, season, week, notes)
           VALUES (@leagueId, @teamId, 'add', @source, @playerId, @fromTeamId, @season, @week, @notes)`,
          {
            leagueId,
            teamId: origin.id,
            source: COMMISH,
            playerId: tx.player_id,
            fromTeamId: tx.team_id,
            season,
            week,
            notes: `Undo of transaction #${tx.id}`,
          },
        ),
      )
      summary.push(`${tx.player_name} returned to ${origin.name}`)
    } else {
      writes.push(
        stmt('DELETE FROM roster_players WHERE league_id = @leagueId AND player_id = @playerId', {
          leagueId,
          playerId: tx.player_id,
        }),
      )
      summary.push(`${tx.player_name} removed from ${tx.team_name}`)
    }

    // And whoever was dropped to make room comes back, provided nobody else
    // has claimed them in the meantime.
    if (tx.related_player_id) {
      const dropped = await locate(leagueId, tx.related_player_id)
      if (dropped.teamId) {
        summary.push(
          `${tx.related_player_name} could NOT be restored — ${dropped.teamName} signed them in the meantime`,
        )
      } else {
        writes.push(
          stmt(
            `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via, on_ir)
             VALUES (@leagueId, @teamId, @playerId, @source, 0)`,
            { leagueId, teamId: tx.team_id, playerId: tx.related_player_id, source: COMMISH },
          ),
          poolStatements.clearWaiverState(leagueId, tx.related_player_id),
          stmt(
            `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
             VALUES (@leagueId, @teamId, 'add', @source, @playerId, @season, @week, @notes)`,
            {
              leagueId,
              teamId: tx.team_id,
              source: COMMISH,
              playerId: tx.related_player_id,
              season,
              week,
              notes: `Undo of transaction #${tx.id}`,
            },
          ),
        )
        summary.push(`${tx.related_player_name} restored to ${tx.team_name}`)
      }
    }
  }

  if (tx.type === 'drop') {
    const current = await locate(leagueId, tx.player_id)
    if (current.teamId) {
      throw httpError(
        `${tx.player_name} is on ${current.teamName} now — this drop has already been reversed, or someone has since signed them.`,
        409,
        'STALE',
      )
    }
    writes.push(
      stmt(
        `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via, on_ir)
         VALUES (@leagueId, @teamId, @playerId, @source, 0)`,
        { leagueId, teamId: tx.team_id, playerId: tx.player_id, source: COMMISH },
      ),
      poolStatements.clearWaiverState(leagueId, tx.player_id),
      stmt(
        `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
         VALUES (@leagueId, @teamId, 'add', @source, @playerId, @season, @week, @notes)`,
        {
          leagueId,
          teamId: tx.team_id,
          source: COMMISH,
          playerId: tx.player_id,
          season,
          week,
          notes: `Undo of transaction #${tx.id}`,
        },
      ),
    )
    summary.push(`${tx.player_name} restored to ${tx.team_name}`)
  }

  writes.push(
    systemMessageStatement({
      leagueId,
      teamId: tx.team_id,
      eventType: 'commissioner',
      body: `Commissioner reversed a move — ${summary.join('; ')}.`,
      meta: { undoneTransactionId: tx.id, action: 'undo' },
    }),
  )

  await batch(writes)
  return { transactionId: tx.id, summary }
}

/**
 * Reverse an accepted trade, sending every player back where they came from.
 *
 * Refuses unless all of them are still sitting where the trade put them. A
 * partial reversal is worse than none: it would hand back one side of a deal
 * while the other side keeps what it received.
 */
export async function reverseTrade({ leagueId, league, tradeId }) {
  const trade = await get(
    `SELECT tr.*, pt.name AS proposer_name, rt.name AS receiver_name
       FROM trades tr
       JOIN teams pt ON pt.id = tr.proposer_team_id
       JOIN teams rt ON rt.id = tr.receiver_team_id
      WHERE tr.id = @tradeId AND tr.league_id = @leagueId`,
    { tradeId, leagueId },
  )
  if (!trade) throw httpError('Trade not found.', 404)
  if (trade.status !== 'accepted') {
    throw httpError(`Only an accepted trade can be reversed — this one is ${trade.status}.`, 409)
  }

  const items = await query(
    `SELECT ti.player_id, ti.from_team_id, p.full_name, rp.team_id AS current_team_id, t.name AS current_team_name
       FROM trade_items ti
       JOIN players p ON p.id = ti.player_id
       LEFT JOIN roster_players rp ON rp.player_id = ti.player_id AND rp.league_id = @leagueId
       LEFT JOIN teams t ON t.id = rp.team_id
      WHERE ti.trade_id = @tradeId`,
    { tradeId, leagueId },
  )
  if (!items.length) throw httpError('This trade has no players to move back.', 409)

  // Everyone must still be on the team the trade sent them to.
  const moved = items.filter((item) => {
    const landedOn =
      item.from_team_id === trade.proposer_team_id ? trade.receiver_team_id : trade.proposer_team_id
    return item.current_team_id !== landedOn
  })
  if (moved.length) {
    throw httpError(
      `Can't reverse this trade — ${moved
        .map((m) => `${m.full_name} is ${m.current_team_name ? `on ${m.current_team_name}` : 'no longer rostered'}`)
        .join(', ')}. Move them back by hand first, then reverse the trade.`,
      409,
      'STALE',
    )
  }

  const { season, week } = leagueWeek(league)
  const writes = items.flatMap((item) => [
    stmt(
      `UPDATE roster_players SET team_id = @toTeamId, acquired_via = @source,
                                 acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE league_id = @leagueId AND player_id = @playerId`,
      { leagueId, playerId: item.player_id, toTeamId: item.from_team_id, source: COMMISH },
    ),
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
          AND week = @week AND player_id = @playerId`,
      { leagueId, teamId: item.current_team_id, season, week, playerId: item.player_id },
    ),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_team_id, season, week, notes)
       VALUES (@leagueId, @teamId, 'trade', @source, @playerId, @fromTeamId, @season, @week, @notes)`,
      {
        leagueId,
        teamId: item.from_team_id,
        source: COMMISH,
        playerId: item.player_id,
        fromTeamId: item.current_team_id,
        season,
        week,
        notes: `Reversal of trade #${tradeId}`,
      },
    ),
  ])

  writes.push(
    stmt(
      `UPDATE trades SET status = 'reversed',
              response_message = 'Reversed by the commissioner.', resolved_at = @at
        WHERE id = @tradeId`,
      { tradeId, at: new Date().toISOString() },
    ),
    systemMessageStatement({
      leagueId,
      teamId: trade.proposer_team_id,
      eventType: 'commissioner',
      body:
        `Commissioner reversed the trade between ${trade.proposer_name} and ${trade.receiver_name} — ` +
        `${items.map((i) => i.full_name).join(', ')} sent back.`,
      meta: { tradeId, action: 'reverse-trade' },
    }),
  )

  await batch(writes)
  return { tradeId, playersMoved: items.length }
}

// ---------------------------------------------------------------------------
// League state
// ---------------------------------------------------------------------------

/**
 * Move the league to a different week.
 *
 * The recovery lever for a week that advanced early — a missed tick replaying
 * after an outage, or a week-reset run by hand at the wrong moment. Seeds
 * lineup rows for the destination so rosters render.
 */
export async function setCurrentWeek({ leagueId, league, week }) {
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    throw httpError('Week must be a whole number between 1 and 18.')
  }
  if (week === league.current_week) return { week, unchanged: true }

  await run('UPDATE leagues SET current_week = @week WHERE id = @leagueId', { week, leagueId })

  const teams = await query('SELECT id FROM teams WHERE league_id = @leagueId', { leagueId })
  for (const team of teams) await ensureLineupRows(leagueId, team.id, league.season, week)

  await run(
    `INSERT INTO messages (league_id, kind, event_type, body)
     VALUES (@leagueId, 'system', 'commissioner', @body)`,
    { leagueId, body: `Commissioner set the league to week ${week} (was week ${league.current_week}).` },
  )

  return { week, previousWeek: league.current_week }
}

// ---------------------------------------------------------------------------
// Read models for the console
// ---------------------------------------------------------------------------

/** Recent transactions, annotated with whether each one can still be undone. */
export async function listUndoableTransactions(leagueId, limit = 40) {
  const rows = await query(
    `SELECT tx.id, tx.type, tx.source, tx.season, tx.week, tx.notes, tx.created_at,
            tx.player_id, tx.related_player_id, tx.team_id, tx.related_team_id,
            t.name AS team_name, origin.name AS related_team_name,
            p.full_name AS player_name, p.position, p.nfl_team,
            related.full_name AS related_player_name,
            owner.team_id AS player_current_team_id
       FROM transactions tx
       LEFT JOIN teams t ON t.id = tx.team_id
       LEFT JOIN teams origin ON origin.id = tx.related_team_id
       LEFT JOIN players p ON p.id = tx.player_id
       LEFT JOIN players related ON related.id = tx.related_player_id
       LEFT JOIN roster_players owner ON owner.player_id = tx.player_id AND owner.league_id = tx.league_id
      WHERE tx.league_id = @leagueId
      ORDER BY tx.created_at DESC, tx.id DESC
      LIMIT @limit`,
    { leagueId, limit },
  )

  return rows.map((row) => {
    let undoable = false
    let blockedReason = null

    if (row.type === 'trade') {
      blockedReason = 'Part of a trade — reverse the trade instead.'
    } else if (row.type === 'add') {
      undoable = row.player_current_team_id === row.team_id
      if (!undoable) blockedReason = `${row.player_name} has moved since.`
    } else if (row.type === 'drop') {
      undoable = row.player_current_team_id === null
      if (!undoable) blockedReason = `${row.player_name} has been signed since.`
    } else {
      blockedReason = 'Not a roster move.'
    }

    return { ...row, undoable, blockedReason }
  })
}

/** Accepted trades, with whether a clean reversal is still possible. */
export async function listReversibleTrades(leagueId, limit = 25) {
  const trades = await query(
    `SELECT tr.id, tr.status, tr.season, tr.week, tr.created_at, tr.resolved_at,
            pt.name AS proposer_name, rt.name AS receiver_name,
            tr.proposer_team_id, tr.receiver_team_id
       FROM trades tr
       JOIN teams pt ON pt.id = tr.proposer_team_id
       JOIN teams rt ON rt.id = tr.receiver_team_id
      WHERE tr.league_id = @leagueId AND tr.status IN ('accepted', 'reversed')
      ORDER BY tr.resolved_at DESC, tr.id DESC
      LIMIT @limit`,
    { leagueId, limit },
  )
  if (!trades.length) return []

  const items = await query(
    `SELECT ti.trade_id, ti.player_id, ti.from_team_id, p.full_name, rp.team_id AS current_team_id
       FROM trade_items ti
       JOIN trades tr ON tr.id = ti.trade_id
       JOIN players p ON p.id = ti.player_id
       LEFT JOIN roster_players rp ON rp.player_id = ti.player_id AND rp.league_id = tr.league_id
      WHERE tr.league_id = @leagueId AND tr.status IN ('accepted', 'reversed')`,
    { leagueId },
  )

  const byTrade = new Map()
  for (const item of items) {
    if (!byTrade.has(item.trade_id)) byTrade.set(item.trade_id, [])
    byTrade.get(item.trade_id).push(item)
  }

  return trades.map((trade) => {
    const own = byTrade.get(trade.id) ?? []
    const stale = own.filter((item) => {
      const landedOn =
        item.from_team_id === trade.proposer_team_id ? trade.receiver_team_id : trade.proposer_team_id
      return item.current_team_id !== landedOn
    })

    return {
      ...trade,
      players: own.map((i) => ({
        id: i.player_id,
        name: i.full_name,
        fromTeamId: i.from_team_id,
      })),
      reversible: trade.status === 'accepted' && stale.length === 0,
      blockedReason:
        trade.status !== 'accepted'
          ? 'Already reversed.'
          : stale.length
            ? `${stale.map((s) => s.full_name).join(', ')} moved on after this trade.`
            : null,
    }
  })
}

/** Every roster in the league, flat, for the roster editor. */
export async function listAllRosters(leagueId) {
  const [teams, players] = await Promise.all([
    query(
      'SELECT id, name, abbreviation FROM teams WHERE league_id = @leagueId ORDER BY name',
      { leagueId },
    ),
    query(
      `SELECT rp.team_id, rp.on_ir, rp.acquired_via, rp.acquired_at,
              p.id, p.full_name, p.position, p.nfl_team, p.injury_status
         FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId
        ORDER BY p.position, p.full_name`,
      { leagueId },
    ),
  ])

  return teams.map((team) => ({
    ...team,
    players: players.filter((p) => p.team_id === team.id),
  }))
}

/** Matchups for a week, with their override state, for the score editor. */
export function listMatchupsForWeek(leagueId, season, week) {
  return query(
    `SELECT m.id, m.week, m.status, m.home_score, m.away_score, m.manual_override,
            h.name AS home_name, a.name AS away_name
       FROM matchups m
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
      WHERE m.league_id = @leagueId AND m.season = @season AND m.week = @week
      ORDER BY m.id`,
    { leagueId, season, week },
  )
}
