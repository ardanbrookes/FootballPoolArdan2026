/**
 * The automated jobs that drive the league week.
 *
 * Each is safe to run by hand (see routes/admin.js) and idempotent enough to
 * re-run if a scheduled invocation is missed.
 */

import { get, query, run, batch, stmt } from '../db.js'
import { processWaivers } from '../services/waivers.js'
import { resetPoolToWaivers, nextWaiverClearTime } from '../services/players.js'
import { ensureLineupRows } from '../services/roster.js'
import {
  recalculateMatchups,
  recalculateStandings,
  rebuildRestOfSeasonPoints,
} from '../services/scoring.js'
import { ensurePlayoffMatchups } from '../services/playoffs.js'
import { playoffs } from '../config.js'
import {
  syncWeekStats,
  syncWeekProjections,
  syncRestOfSeasonProjections,
  syncPlayers,
  recordSync,
} from '../services/sleeper.js'
import { syncWeek } from '../services/schedule.js'
import { pruneNews, clearUnresolvedXref } from '../services/news.js'
import { expirePendingTrades } from '../services/trades.js'

function allLeagues() {
  return query('SELECT id, season, season_type, current_week, playoff_week FROM leagues')
}

async function leaguesFor(leagueId) {
  if (!leagueId) return allLeagues()
  const league = await get('SELECT * FROM leagues WHERE id = @leagueId', { leagueId })
  return league ? [league] : []
}

/**
 * Tuesday 3:00 AM (configurable): resolve every pending claim, then release
 * everyone left over into free agency.
 */
export async function runWaiverProcessing({ leagueId } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    try {
      const result = await processWaivers(league.id)
      results.push({ leagueId: league.id, ...result })
      await recordSync(
        `waivers:${league.id}`,
        'ok',
        `${result.succeeded} awarded, ${result.failed} failed, ${result.freedAgents} to free agency`,
      )
      console.log(
        `[waivers] league ${league.id}: ${result.succeeded} awarded, ${result.failed} failed, ` +
          `${result.freedAgents} released to free agency`,
      )
    } catch (err) {
      console.error(`[waivers] league ${league.id} failed:`, err.message)
      await recordSync(`waivers:${league.id}`, 'error', err.message)
      // Reported rather than swallowed, so the tick leaves this boundary
      // unmarked and tries again. Swallowing it marked the run done, which
      // would have left every unrostered player on waivers for a whole week.
      results.push({ leagueId: league.id, error: err.message })
    }
  }

  return results
}

/**
 * Sunday 1:00 PM: the pool closes.
 *
 * Every remaining free agent goes on waivers, so from the moment the early games
 * kick off nobody can be picked up instantly — they can only be claimed, and the
 * claim doesn't resolve until Tuesday. Separate from the week reset because it
 * happens a day and a half earlier.
 */
export async function runPoolClose({ leagueId } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    const pool = await resetPoolToWaivers(league.id, await nextWaiverClearTime(league.id))

    // Pending offers die with the lock. Trades are closed from here until the
    // week resets, so anything still outstanding can't be accepted anyway —
    // and an offer made on Thursday means something very different once
    // Sunday's injuries are known. Better to expire it than leave it hanging.
    const expired = await expirePendingTrades(league.id)

    results.push({ leagueId: league.id, playersOnWaivers: pool.count, tradesExpired: expired.count })
    await recordSync(
      `pool-close:${league.id}`,
      'ok',
      `${pool.count} free agents moved to waivers, ${expired.count} trades expired`,
    )
    console.log(
      `[pool-close] league ${league.id}: ${pool.count} to waivers, ${expired.count} trades expired`,
    )
  }

  return results
}

/**
 * Monday night, once the week's last game has finished.
 *
 * Finalises scores and standings, advances current_week, and seeds next week's
 * lineup rows — which is what reopens rosters and trades. The player pool is
 * left alone here; it was closed at the Sunday lock and reopens on Tuesday when
 * claims process.
 *
 * Advancing the week is the LAST step, and it's the commit point. Everything
 * before it is idempotent against the same finished week, so a run that fails
 * part-way simply redoes it on retry. With the advance in the middle, a retry
 * after a mid-way failure would have finalised the week after instead.
 */
export async function runWeekReset({ leagueId } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    const finishedWeek = league.current_week
    const nextWeek = finishedWeek + 1

    await recalculateMatchups(league.id, league.season, finishedWeek, { markFinal: true })
    await recalculateStandings(league.id, league.season)

    const teams = await query('SELECT id FROM teams WHERE league_id = @leagueId', { leagueId: league.id })
    for (const team of teams) {
      await ensureLineupRows(league.id, team.id, league.season, nextWeek)
      await carryForwardLineup(league.id, team.id, league.season, finishedWeek, nextWeek)
    }

    // Compare-and-set: two runs racing (a manual reset landing during a tick)
    // can't advance the league twice.
    const advanced = await run(
      `UPDATE leagues SET current_week = @nextWeek
        WHERE id = @leagueId AND current_week = @finishedWeek`,
      { nextWeek, finishedWeek, leagueId: league.id },
    )
    if (!advanced?.changes) {
      results.push({ leagueId: league.id, finishedWeek, skipped: 'week had already advanced' })
      continue
    }

    // Entering the playoffs: seed the bracket. No-op during the regular season,
    // and idempotent once created. After the advance, because it keys off the
    // league's new week.
    const bracket = await ensurePlayoffMatchups(league.id)
    if (bracket.created) {
      console.log(`[week-reset] league ${league.id}: bracket set — ${bracket.detail.join('; ')}`)
    }

    results.push({
      leagueId: league.id,
      finishedWeek,
      nextWeek,
      playoffMatchupsCreated: bracket.created,
    })
    await recordSync(`week-reset:${league.id}`, 'ok', `week ${finishedWeek} final -> week ${nextWeek}`)
    console.log(
      `[week-reset] league ${league.id}: week ${finishedWeek} final, now week ${nextWeek}`,
    )
  }

  return results
}

/**
 * Start next week's lineup as a copy of the one just played, skipping anyone
 * no longer rostered.
 *
 * Overwrites rather than filling gaps: the reset is the authority on what next
 * week starts from. Filling only empty slots let an early copy survive the real
 * reset, handing a team a lineup days out of date — including players it had
 * since dropped.
 */
async function carryForwardLineup(leagueId, teamId, season, fromWeek, toWeek) {
  const previous = await query(
    `SELECT l.slot, l.player_id FROM lineups l
       JOIN roster_players rp ON rp.player_id = l.player_id AND rp.league_id = l.league_id
      WHERE l.league_id = @leagueId AND l.team_id = @teamId AND l.season = @season
        AND l.week = @fromWeek AND l.player_id IS NOT NULL AND rp.team_id = @teamId`,
    { leagueId, teamId, season, fromWeek },
  )

  // One batch, so the clear and the copy land together.
  await batch([
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season AND week = @toWeek`,
      { leagueId, teamId, season, toWeek },
    ),
    ...previous.map((row) =>
      stmt(
        `UPDATE lineups SET player_id = @playerId
          WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
            AND week = @toWeek AND slot = @slot`,
        { leagueId, teamId, season, toWeek, slot: row.slot, playerId: row.player_id },
      ),
    ),
  ])
}

/**
 * Is there any football to sync right now?
 *
 * The tick fires every 15 minutes all week, but stats only change while games
 * are being played. Refreshing on a Wednesday rewrote every stat line for
 * nothing — roughly 1,600 writes a tick, 96 ticks a day, which on its own blew
 * past the daily write limit.
 *
 * The window is deliberately generous: any game that kicked off in the last six
 * hours, which covers a game running long and final stats settling afterwards.
 * A game ESPN still reports as in progress counts too, but only for twelve
 * hours — a status left stuck by a failed sync must not keep the refresh (and
 * its reads) running for the rest of the week.
 */
async function hasLiveFootball(season, week, seasonType) {
  const nowMs = Date.now()
  const row = await get(
    `SELECT COUNT(*) AS n FROM nfl_games
      WHERE season = @season AND week = @week AND season_type = @seasonType
        AND kickoff_at <= @now
        AND (kickoff_at >= @since OR (status = 'in_progress' AND kickoff_at >= @stale))`,
    {
      season,
      week,
      seasonType,
      now: new Date(nowMs).toISOString(),
      since: new Date(nowMs - 6 * 3600_000).toISOString(),
      stale: new Date(nowMs - 12 * 3600_000).toISOString(),
    },
  )
  return (row?.n ?? 0) > 0
}

/** Refresh live stats and game status for the current week, then re-score matchups. */
export async function runStatsRefresh({ leagueId, force = false } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    try {
      // Projections are NOT refreshed here any more. They move about once a
      // day, not every 15 minutes, and the daily sync already covers the
      // current week as part of the rest-of-season pass.
      if (!force && !(await hasLiveFootball(league.season, league.current_week, league.season_type))) {
        results.push({ leagueId: league.id, skipped: 'no games in progress' })
        continue
      }

      // Real game status while games are on — kickoffs, overtime, finals — so
      // scoreboards can say LIVE and FINAL. Best effort: services/schedule.js
      // derives a status from the kickoff time whenever this hasn't landed.
      const schedule = await syncWeek(league.season, league.current_week, league.season_type).catch(
        (err) => ({ error: err.message }),
      )

      const stats = await syncWeekStats(league.season, league.current_week, league.season_type)
      await recalculateMatchups(league.id, league.season, league.current_week)
      results.push({
        leagueId: league.id,
        statLines: stats.count,
        games: schedule.games ?? null,
        ...(schedule.error ? { scheduleError: schedule.error } : {}),
      })
    } catch (err) {
      console.error(`[stats] league ${league.id} refresh failed:`, err.message)
    }
  }

  return results
}

/** Daily housekeeping: refresh the player dictionary and this week's kickoff times. */
export async function runDailySync() {
  const summary = { players: null, schedules: [] }

  try {
    const players = await syncPlayers()
    summary.players = players
    if (!players.skipped) console.log(`[sync] players refreshed (${players.count})`)
  } catch (err) {
    console.error('[sync] player sync failed:', err.message)
    summary.players = { error: err.message }
  }

  for (const league of await allLeagues()) {
    try {
      summary.schedules.push(await syncWeek(league.season, league.current_week, league.season_type))
    } catch (err) {
      console.error(`[sync] schedule sync failed for league ${league.id}:`, err.message)
    }

    // Rest-of-season projections, for trade evaluation. Self-throttling: weeks
    // already fetched recently are skipped, so this is only expensive once.
    try {
      const ros = await syncRestOfSeasonProjections(
        league.season,
        league.current_week,
        playoffs.regularSeasonWeeks,
        league.season_type,
      )
      summary.restOfSeason = ros
      // Roll the freshly synced weeks into one total per player, so reads are
      // one row rather than fourteen.
      summary.rosRollup = await rebuildRestOfSeasonPoints(
        league.season,
        league.current_week,
        playoffs.regularSeasonWeeks,
        league.season_type,
      )
    } catch (err) {
      console.error('[sync] rest-of-season projections failed:', err.message)
    }
  }

  // Keep the news archive from growing without end. Two months is well past
  // the point anyone scrolls back, and comfortably covers a full season's
  // history for a single player.
  try {
    summary.newsPruned = (await pruneNews()).deleted
    // Order matters: the player dictionary has just been refreshed above, so
    // names that failed to resolve yesterday get another go against it.
    summary.newsXrefCleared = (await clearUnresolvedXref()).cleared
  } catch (err) {
    console.error('[sync] news maintenance failed:', err.message)
  }

  await recordSync('daily-sync', 'ok', JSON.stringify(summary).slice(0, 200))
  return summary
}
