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
 *
 * "Passed and not yet run" is not enough on its own. Two guards sit on top:
 *
 *   - Boundaries from before the season's first kickoff never fire. The cycle
 *     is anchored on the Sunday lock, so a midweek opener lands in a cycle
 *     whose Sunday lock, week reset and waiver run all fell in the preseason.
 *     Once the season started all three were "passed and never run", and they
 *     fired together in the first tick — finalising week 1 minutes after
 *     kickoff.
 *
 *   - The week reset only runs when the schedule says the league's current
 *     week is the one that just finished. The clock can say a boundary has
 *     passed; only the schedule can say a week is over.
 *
 * Every job is isolated: one failing is reported and retried on the next tick
 * rather than aborting everything queued after it, and its boundary is only
 * marked done once it has actually succeeded.
 */

import { query } from '../db.js'
import { now as clockNow, toIso, fromIso, label } from '../services/clock.js'
import { getTiming } from '../services/settings.js'
import { getLockState, PHASE } from '../services/locks.js'
import { announcePhaseChange, postSystemMessage } from '../services/chat.js'
import { getSyncEntry, recordSync } from '../services/sleeper.js'
import { placeTeamsOnWaivers, nextWaiverClearTime } from '../services/players.js'
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

/**
 * Why the week reset must not run this cycle, or null if it may.
 *
 * The reset finalises `current_week` and moves the league on, which is only
 * right when that week is the one the schedule just finished. A cycle with no
 * games of its own has nothing to finish, and a league already ahead of the
 * schedule must not be pushed further ahead.
 */
function resetBlocker(lockState, league) {
  const finished = lockState.completedWeek
  if (finished == null) return 'no NFL week finished this cycle'
  if (finished < league.current_week) {
    return `league is on week ${league.current_week} but the schedule has only finished week ${finished}`
  }
  return null
}

/**
 * Run one boundary job, marking the boundary done only if it succeeds.
 *
 * A skip is marked too, so it is decided once per cycle rather than re-argued
 * every 15 minutes — and it lands in the sync log, which is how a boundary
 * that deliberately did nothing stays legible afterwards.
 */
async function runBoundary({ leagueId, job, key, boundaryIso, skip, work }, ran) {
  if (skip) {
    await recordSync(key, 'skipped', `${skip} (cycle ${boundaryIso})`)
    ran.push({ leagueId, job, skipped: skip })
    return
  }
  try {
    await work()
    await recordSync(key, 'ok', `cycle ${boundaryIso}`)
    ran.push({ leagueId, job })
  } catch (err) {
    // Deliberately not recorded, so the next tick tries again.
    console.error(`[tick] ${job} failed for league ${leagueId}:`, err)
    ran.push({ leagueId, job, error: String(err.message || err) })
  }
}

/** "NE and SEA", "LAR, NE, SEA and SF". */
function listTeams(teams) {
  return teams.length < 2 ? teams.join('') : `${teams.slice(0, -1).join(', ')} and ${teams[teams.length - 1]}`
}

/**
 * Put the unrostered players of teams that have already kicked off on waivers.
 *
 * They're locked from kickoff, so as free agents nobody could add them — they
 * sat in limbo until the Sunday lock caught up. On waivers they can be claimed
 * straight away.
 *
 * Keyed on the set of teams locked this cycle, so it runs once per kickoff
 * rather than every tick, only announces the teams that are new, and leaves a
 * commissioner's manual availability change alone afterwards.
 */
async function waiverKickedOffTeams(league, lockState, timing, force, ran) {
  if (lockState.phase !== PHASE.EARLY_GAME_LOCK || !lockState.lockedNflTeams.length) return

  const cycleAt = lockState.cycle.blanketLockAt
  const teams = [...lockState.lockedNflTeams].sort()
  const key = `tick:early-waivers:${league.id}`
  const signature = `${cycleAt} ${teams.join(',')}`

  const last = await getSyncEntry(key)
  if (force !== 'early-waivers' && last?.detail === signature) return

  const [lastCycle, lastTeams = ''] = (last?.detail ?? '').split(' ')
  const announced = new Set(lastCycle === cycleAt ? lastTeams.split(',') : [])
  const fresh = teams.filter((team) => !announced.has(team))

  try {
    const clearAt = await nextWaiverClearTime(league.id)
    const moved = await placeTeamsOnWaivers(league.id, teams, clearAt)

    if (moved.count) {
      await postSystemMessage({
        leagueId: league.id,
        eventType: 'waiver',
        body:
          `${listTeams(fresh.length ? fresh : teams)} have kicked off — their unrostered players are on ` +
          `waivers until ${label(fromIso(clearAt, timing.timezone))}. Put in a claim to pick one up.`,
        meta: { teams: fresh, clearAt },
      })
    }

    await recordSync(key, 'ok', signature)
    ran.push({ leagueId: league.id, job: 'early-waivers', teams, moved: moved.count })
  } catch (err) {
    console.error(`[tick] early-waivers failed for league ${league.id}:`, err)
    ran.push({ leagueId: league.id, job: 'early-waivers', error: String(err.message || err) })
  }
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

    // A forced run is a deliberate manual action, so it bypasses the guards.
    const guard = (job, reason) => (force === job ? null : reason)
    const beforeSeason = (boundaryIso) =>
      lockState.seasonStartsAt && boundaryIso < lockState.seasonStartsAt
        ? 'boundary fell before the season started'
        : null

    // Chronological order within the cycle, so a league catching up after an
    // outage replays the boundaries in the order they actually happened.
    const closeKey = `tick:pool-close:${league.id}`
    if (force === 'pool-close' || (await isDue(closeKey, cycle.blanketLockAt, nowIso))) {
      await runBoundary(
        {
          leagueId: league.id,
          job: 'pool-close',
          key: closeKey,
          boundaryIso: cycle.blanketLockAt,
          skip: guard('pool-close', beforeSeason(cycle.blanketLockAt)),
          work: () => runPoolClose({ leagueId: league.id }),
        },
        ran,
      )
    }

    const resetKey = `tick:week-reset:${league.id}`
    if (force === 'week-reset' || (await isDue(resetKey, cycle.weekResetAt, nowIso))) {
      await runBoundary(
        {
          leagueId: league.id,
          job: 'week-reset',
          key: resetKey,
          boundaryIso: cycle.weekResetAt,
          skip: guard('week-reset', beforeSeason(cycle.weekResetAt) || resetBlocker(lockState, league)),
          work: () => runWeekReset({ leagueId: league.id }),
        },
        ran,
      )
    }

    const waiverKey = `tick:waivers:${league.id}`
    if (force === 'waivers' || (await isDue(waiverKey, cycle.waiverProcessAt, nowIso))) {
      await runBoundary(
        {
          leagueId: league.id,
          job: 'waivers',
          key: waiverKey,
          boundaryIso: cycle.waiverProcessAt,
          skip: guard('waivers', beforeSeason(cycle.waiverProcessAt)),
          work: async () => {
            const [result] = await runWaiverProcessing({ leagueId: league.id })
            if (result?.error) throw new Error(result.error)
          },
        },
        ran,
      )
    }

    await waiverKickedOffTeams(league, lockState, timing, force, ran)
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
  // One club's feed is pulled alongside the league feed, rotating through all
  // 32 — ESPN caps each feed at 50 articles, and the rotation is what makes
  // per-player history exist at all.
  //
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
    try {
      await runDailySync()
      await recordSync(dailyKey, 'ok', 'daily sync complete')
      ran.push({ job: 'daily-sync' })
    } catch (err) {
      console.error('[tick] daily sync failed:', err)
      ran.push({ job: 'daily-sync', error: String(err.message || err) })
    }
  }

  return { ran, checkedLeagues: leagues.length }
}
