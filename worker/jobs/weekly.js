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
import { recalculateMatchups, recalculateStandings } from '../services/scoring.js'
import { ensurePlayoffMatchups } from '../services/playoffs.js'
import { syncWeekStats, syncWeekProjections, syncPlayers, recordSync } from '../services/sleeper.js'
import { syncWeek } from '../services/schedule.js'

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
    results.push({ leagueId: league.id, playersOnWaivers: pool.count })
    await recordSync(`pool-close:${league.id}`, 'ok', `${pool.count} free agents moved to waivers`)
    console.log(`[pool-close] league ${league.id}: ${pool.count} free agents moved to waivers`)
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
 */
export async function runWeekReset({ leagueId } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    const finishedWeek = league.current_week
    const nextWeek = finishedWeek + 1

    await recalculateMatchups(league.id, league.season, finishedWeek, { markFinal: true })
    await recalculateStandings(league.id, league.season)

    await run('UPDATE leagues SET current_week = @nextWeek WHERE id = @leagueId', {
      nextWeek,
      leagueId: league.id,
    })

    const teams = await query('SELECT id FROM teams WHERE league_id = @leagueId', { leagueId: league.id })
    for (const team of teams) {
      await ensureLineupRows(league.id, team.id, league.season, nextWeek)
      await carryForwardLineup(league.id, team.id, league.season, finishedWeek, nextWeek)
    }

    // Entering the playoffs: seed the bracket. No-op during the regular season,
    // and idempotent once created.
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

/** Copy a team's lineup from one week to the next, skipping anyone no longer rostered. */
async function carryForwardLineup(leagueId, teamId, season, fromWeek, toWeek) {
  const previous = await query(
    `SELECT l.slot, l.player_id FROM lineups l
       JOIN roster_players rp ON rp.player_id = l.player_id AND rp.league_id = l.league_id
      WHERE l.league_id = @leagueId AND l.team_id = @teamId AND l.season = @season
        AND l.week = @fromWeek AND l.player_id IS NOT NULL AND rp.team_id = @teamId`,
    { leagueId, teamId, season, fromWeek },
  )

  await batch(
    previous.map((row) =>
      stmt(
        `UPDATE lineups SET player_id = @playerId
          WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
            AND week = @toWeek AND slot = @slot AND player_id IS NULL`,
        { leagueId, teamId, season, toWeek, slot: row.slot, playerId: row.player_id },
      ),
    ),
  )
}

/** Refresh live stats for the current week and re-score matchups. */
export async function runStatsRefresh({ leagueId } = {}) {
  const results = []

  for (const league of await leaguesFor(leagueId)) {
    try {
      // Projections alongside stats: they're the same endpoint shape and the
      // player pool wants next week's number next to this week's result.
      await syncWeekProjections(league.season, league.current_week, league.season_type).catch((err) =>
        console.warn(`[stats] projections unavailable for week ${league.current_week}: ${err.message}`),
      )
      const stats = await syncWeekStats(league.season, league.current_week, league.season_type)
      await recalculateMatchups(league.id, league.season, league.current_week)
      results.push({ leagueId: league.id, statLines: stats.count })
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
  }

  await recordSync('daily-sync', 'ok', JSON.stringify(summary).slice(0, 200))
  return summary
}
