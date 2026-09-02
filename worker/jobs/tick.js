/**
 * Cron dispatcher.
 *
 * Cloudflare Cron Triggers fire in UTC only, so a literal "Tuesday 3am Eastern"
 * schedule would drift by an hour twice a year. Instead the trigger fires every
 * 15 minutes and this decides what is actually due, using the same league clock
 * that drives the lock state machine.
 *
 * Each job records its last run in `sync_log`. A job fires when the cycle
 * boundary has passed and the recorded run predates that boundary — which makes
 * the whole thing idempotent and self-healing: a missed tick (deploy, outage)
 * simply runs on the next one instead of being skipped forever.
 */

import { query } from '../db.js'
import { now as clockNow, toIso } from '../services/clock.js'
import { getTiming } from '../services/settings.js'
import { getLockState } from '../services/locks.js'
import { announcePhaseChange } from '../services/chat.js'
import { getSyncEntry, recordSync } from '../services/sleeper.js'
import { ingestNews, TEAM_ROTATION } from '../services/news.js'
import {
  runWaiverProcessing,
  runWeekReset,
  runPoolClose,
  runStatsRefresh,
  runDailySync,
} from './weekly.js'

/**
 * Has `boundary` passed, without `key` having run since?
 * A missing log entry counts as due, so a fresh league catches up once.
 */
async function isDue(key, boundaryIso, nowIso) {
  if (boundaryIso > nowIso) return false
  const entry = await getSyncEntry(key)
  if (!entry) return true
  return entry.last_run_at < boundaryIso
}

export async function runTick({ force = null } = {}) {
  const leagues = await query('SELECT id, season, season_type, current_week FROM leagues')
  const ran = []

  for (const league of leagues) {
    const timing = await getTiming(league.id)
    const at = clockNow(timing.timezone)
    const nowIso = toIso(at)

    // The lock state already derives the schedule-dependent reset boundary, so
    // take the cycle from there rather than recomputing it with a fallback.
    const lockState = await getLockState(league.id, at)
    const cycle = lockState.cycle

    // Announce phase changes in the league feed. The service only posts when the
    // phase actually differs, so a 15-minute tick doesn't spam "still open".
    const announced = await announcePhaseChange(
      league.id,
      lockState.phase,
      lockState.phaseLabel,
      lockState.nextDeadline?.label ?? null,
    )
    if (announced.posted) ran.push({ leagueId: league.id, job: 'phase-announce', phase: announced.phase })

    // The weekly cycle doesn't exist before the season starts. Running it would
    // close the free agent pool and process waivers in August, which is exactly
    // the confusion this guard removes.
    if (lockState.preseason) {
      ran.push({ leagueId: league.id, job: 'skipped-preseason' })
      continue
    }

    // Chronological order within the cycle, so a league catching up after an
    // outage replays the boundaries in the order they actually happened.
    const closeKey = `tick:pool-close:${league.id}`
    if (force === 'pool-close' || (await isDue(closeKey, cycle.blanketLockAt, nowIso))) {
      await runPoolClose({ leagueId: league.id })
      await recordSync(closeKey, 'ok', `cycle ${cycle.blanketLockAt}`)
      ran.push({ leagueId: league.id, job: 'pool-close' })
    }

    const resetKey = `tick:week-reset:${league.id}`
    if (force === 'week-reset' || (await isDue(resetKey, cycle.weekResetAt, nowIso))) {
      await runWeekReset({ leagueId: league.id })
      await recordSync(resetKey, 'ok', `cycle ${cycle.weekResetAt}`)
      ran.push({ leagueId: league.id, job: 'week-reset' })
    }

    const waiverKey = `tick:waivers:${league.id}`
    if (force === 'waivers' || (await isDue(waiverKey, cycle.waiverProcessAt, nowIso))) {
      await runWaiverProcessing({ leagueId: league.id })
      await recordSync(waiverKey, 'ok', `cycle ${cycle.waiverProcessAt}`)
      ran.push({ leagueId: league.id, job: 'waivers' })
    }
  }

  // Live scoring: cheap enough to run on every tick during the season.
  // Only does anything while games are actually being played — see
  // hasLiveFootball. Reported either way so a quiet tick is legible.
  if (force === 'stats' || force === null) {
    const stats = await runStatsRefresh({ force: force === 'stats' })
    ran.push({ job: 'stats-refresh', detail: stats[0] ?? null })
  }

  // News. Deliberately isolated and last: it is the only job that depends on a
  // third party we don't otherwise rely on, and nothing in the league hinges on
  // it, so a bad day at ESPN must never stop waivers from processing.
  //
  // The league feed comes in every tick. ESPN caps each feed at 50 articles, so
  // one club's feed is pulled alongside it, rotating through all 32 — that
  // deepens the archive to roughly a full lap every eight hours and is what
  // makes per-player history exist at all.
  // Hourly, not every tick. Headlines do not turn over in fifteen minutes, and
  // each pass upserts ~50 articles plus their player tags — four times an hour
  // was a meaningful slice of the daily write allowance for no visible gain.
  const newsKey = 'news'
  const newsEntry = await getSyncEntry(newsKey)
  const newsDue =
    !newsEntry || newsEntry.last_run_at < new Date(Date.now() - 3_600_000).toISOString()

  if (force === 'news' || (force === null && newsDue)) {
    try {
      const league = await ingestNews()
      const index = Math.floor(Date.now() / 3_600_000) % TEAM_ROTATION.length
      const team = await ingestNews({ team: TEAM_ROTATION[index] })
      await recordSync('news', 'ok', `league ${league.stored}/${league.tagged} tagged, ${team.team} ${team.stored}`)
      ran.push({ job: 'news', league: league.stored, team: team.team, tagged: league.tagged + team.tagged })
    } catch (err) {
      await recordSync('news', 'error', String(err.message || err).slice(0, 200))
      ran.push({ job: 'news', error: String(err.message || err) })
    }
  }

  // Player dictionary + kickoff times, once a day.
  const dailyKey = 'tick:daily-sync'
  const daily = await getSyncEntry(dailyKey)
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  if (force === 'daily-sync' || !daily || daily.last_run_at < dayAgo) {
    await runDailySync()
    await recordSync(dailyKey, 'ok', 'daily sync complete')
    ran.push({ job: 'daily-sync' })
  }

  return { ran, checkedLeagues: leagues.length }
}
