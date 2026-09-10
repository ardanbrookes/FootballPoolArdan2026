/**
 * Roster lock rules.
 *
 * The league week is a four-phase machine. Only the Sunday lock is a fixed clock
 * time; the rest are derived from the real NFL schedule.
 *
 *   BLANKET_LOCK     Sun 13:00 -> last game of the week ends (Monday night)
 *       Everything freezes: no lineup changes, no adds, no drops, no trades.
 *       Any remaining free agents go on waivers, so the pool is claim-only.
 *
 *   WAIVER_PERIOD    last game ends -> Tue 03:00
 *       Rosters unlock, standings are final, trades reopen. Everyone unrostered
 *       is on waivers, so claims are queued rather than picked up instantly.
 *
 *   OPEN             Tue 03:00 -> first kickoff of the new week
 *       Claims have resolved. Adds, drops and swaps are first-come-first-served.
 *
 *   EARLY_GAME_LOCK  first kickoff -> Sun 13:00
 *       Thursday Night Football has started, so ONLY the two teams in that game
 *       are locked. Everyone else stays fully open until Sunday. (Any pre-Sunday
 *       game — Black Friday, a late-season Saturday — locks its teams the same
 *       way, which is the same rule generalised.)
 *
 * One rule sits above the phases: a player whose NFL game is in progress is
 * always locked. Deriving the reset from the final whistle mostly removes the
 * need for it, but it still covers a game running long or a schedule change.
 */

import { DateTime } from 'luxon'
import { get, query } from '../db.js'
import { GAME_DURATION_HOURS } from '../config.js'
import { getTiming } from './settings.js'
import { getCycle, now as clockNow, label, toIso } from './clock.js'

export const PHASE = {
  /**
   * Before the season's first kickoff. The weekly cycle hasn't started, so there
   * are no waivers to clear and nothing to lock — free agency is simply open and
   * stays open. Without this the app spent August advertising a Tuesday waiver
   * run that would never mean anything, while the phase claimed free agency and
   * the pool said otherwise.
   */
  PRESEASON: 'preseason',
  BLANKET_LOCK: 'blanket_lock',
  WAIVER_PERIOD: 'waiver_period',
  OPEN: 'open',
  EARLY_GAME_LOCK: 'early_game_lock',
}

/**
 * What the league calls each phase.
 *
 * The weekly cycle has three names from a manager's point of view: the open
 * period, the game period (from the first kickoff until the last whistle,
 * whether the lock is partial or total), and the waiver period. Preseason sits
 * outside the cycle entirely, so it keeps its own name.
 */
export const PHASE_LABEL = {
  [PHASE.PRESEASON]: 'Preseason',
  [PHASE.OPEN]: 'Open period',
  [PHASE.EARLY_GAME_LOCK]: 'Game period',
  [PHASE.BLANKET_LOCK]: 'Game period',
  [PHASE.WAIVER_PERIOD]: 'Waiver period',
}

/**
 * The NFL week whose games surround a given Sunday lock, and when its last game
 * is expected to finish.
 */
async function resolveCompletedWeek(league, blanketLockAt, bufferMinutes) {
  // Games kicking off on the lock Sunday identify the week that is finishing.
  const sundayGame = await get(
    `SELECT week FROM nfl_games
      WHERE season = @season AND season_type = @seasonType
        AND kickoff_at >= @from AND kickoff_at < @to
      ORDER BY kickoff_at ASC LIMIT 1`,
    {
      season: league.season,
      seasonType: league.season_type,
      from: toIso(blanketLockAt),
      to: toIso(blanketLockAt.plus({ hours: 12 })),
    },
  )
  if (!sundayGame) return { week: null, lastGameEndsAt: null }

  const last = await get(
    `SELECT MAX(kickoff_at) AS last_kickoff FROM nfl_games
      WHERE season = @season AND season_type = @seasonType AND week = @week`,
    { season: league.season, seasonType: league.season_type, week: sundayGame.week },
  )
  if (!last?.last_kickoff) return { week: sundayGame.week, lastGameEndsAt: null }

  const endsAt = DateTime.fromISO(last.last_kickoff, { zone: 'utc' })
    .plus({ hours: GAME_DURATION_HOURS, minutes: bufferMinutes })

  return { week: sundayGame.week, lastGameEndsAt: endsAt }
}

/**
 * Full lock picture for a league at an instant.
 */
export async function getLockState(leagueId, ref) {
  const timing = await getTiming(leagueId)
  const at = ref ? ref.setZone(timing.timezone) : clockNow(timing.timezone)

  const league = await get(
    'SELECT id, season, season_type, current_week FROM leagues WHERE id = @leagueId',
    { leagueId },
  )

  // Provisional cycle to locate the Sunday anchor, then refine the reset using
  // the real schedule. The anchor doesn't depend on the reset, so this is safe.
  const anchor = getCycle(at, timing)
  const completed = league
    ? await resolveCompletedWeek(league, anchor.blanketLockAt, timing.weekReset?.bufferMinutes ?? 0)
    : { week: null, lastGameEndsAt: null }

  const cycle = getCycle(at, timing, { lastGameEndsAt: completed.lastGameEndsAt })

  // The week being prepared is the one after the week that just finished.
  const activeWeek = completed.week != null ? completed.week + 1 : (league?.current_week ?? null)

  // Games before the next Sunday lock need individual team locks; Sunday
  // afternoon and later are covered by the blanket lock instead.
  const earlyGames =
    league && activeWeek != null
      ? await query(
          `SELECT home_team, away_team, kickoff_at FROM nfl_games
            WHERE season = @season AND season_type = @seasonType AND week = @week
              AND kickoff_at < @nextLock
            ORDER BY kickoff_at ASC`,
          {
            season: league.season,
            seasonType: league.season_type,
            week: activeWeek,
            nextLock: toIso(cycle.nextBlanketLockAt),
          },
        )
      : []

  const nowIso = toIso(at)
  const lockedNflTeams = new Set()
  let firstKickoff = null

  for (const game of earlyGames) {
    if (!firstKickoff || game.kickoff_at < firstKickoff) firstKickoff = game.kickoff_at
    if (game.kickoff_at <= nowIso) {
      lockedNflTeams.add(game.home_team)
      lockedNflTeams.add(game.away_team)
    }
  }

  // Safety net: any game actually being played locks its two teams.
  const inProgressNflTeams = new Set()
  if (league) {
    const earliestLive = toIso(at.minus({ hours: GAME_DURATION_HOURS }))
    const live = await query(
      `SELECT home_team, away_team FROM nfl_games
        WHERE season = @season AND season_type = @seasonType
          AND kickoff_at <= @now AND kickoff_at > @earliest AND status != 'final'`,
      { season: league.season, seasonType: league.season_type, now: nowIso, earliest: earliestLive },
    )
    for (const game of live) {
      inProgressNflTeams.add(game.home_team)
      inProgressNflTeams.add(game.away_team)
    }
  }

  // Has the season actually started? Everything before the first kickoff is
  // preseason: no cycle, no waivers, free agency permanently open.
  const seasonStart = league
    ? await get(
        `SELECT MIN(kickoff_at) AS first_kickoff FROM nfl_games
          WHERE season = @season AND season_type = @seasonType`,
        { season: league.season, seasonType: league.season_type },
      )
    : null
  const seasonStartsAt = seasonStart?.first_kickoff ?? null
  const preseason = Boolean(seasonStartsAt) && nowIso < seasonStartsAt

  // Out of season — or before the schedule is published — this cycle has no
  // games at either end. Without this the league sits in a blanket lock every
  // Sunday-to-Tuesday of the offseason, with nothing to lock for.
  const cycleHasGames = completed.week != null || earlyGames.length > 0
  const phase = preseason
    ? PHASE.PRESEASON
    : resolvePhase(at, cycle, firstKickoff, cycleHasGames)

  // The week the league should be on right now, according to the schedule.
  // activeWeek is already NEXT week from the Sunday lock onwards — which is
  // what the early-game locks need — but until Monday's final whistle the
  // league is still playing the week that's finishing. Measuring drift against
  // activeWeek would have raised a false alarm every Sunday.
  const expectedWeek =
    completed.week == null ? null : at < cycle.weekResetAt ? completed.week : completed.week + 1

  return {
    phase,
    phaseLabel: PHASE_LABEL[phase],
    activeWeek,
    completedWeek: completed.week,
    expectedWeek,
    weekDrift:
      league && expectedWeek != null && expectedWeek !== league.current_week
        ? { leagueWeek: league.current_week, scheduleWeek: expectedWeek }
        : null,
    cycle: {
      blanketLockAt: toIso(cycle.blanketLockAt),
      weekResetAt: toIso(cycle.weekResetAt),
      waiverProcessAt: toIso(cycle.waiverProcessAt),
      nextBlanketLockAt: toIso(cycle.nextBlanketLockAt),
      firstKickoffAt: firstKickoff,
      weekResetFromSchedule: cycle.weekResetFromSchedule,
      timezone: cycle.zone,
    },
    lockedNflTeams: [...lockedNflTeams],
    inProgressNflTeams: [...inProgressNflTeams],
    preseason,
    seasonStartsAt,
    nextDeadline: nextDeadline(at, cycle, firstKickoff, phase, seasonStartsAt),
    allows: allowsForPhase(phase),
  }
}

function resolvePhase(at, cycle, firstKickoff, cycleHasGames) {
  // No football either side of this cycle: leave everything open.
  if (!cycleHasGames) return PHASE.OPEN
  // Sunday lock through the final whistle: everything frozen.
  if (at < cycle.weekResetAt) return PHASE.BLANKET_LOCK
  // Final whistle through waiver processing: unlocked, but claim-only.
  if (at < cycle.waiverProcessAt) return PHASE.WAIVER_PERIOD
  // After the first kickoff of the new week, that game's teams are locked.
  if (firstKickoff && toIso(at) >= firstKickoff) return PHASE.EARLY_GAME_LOCK
  return PHASE.OPEN
}

function allowsForPhase(phase) {
  switch (phase) {
    case PHASE.PRESEASON:
      // Nothing has been played, so nothing is locked and nobody is on waivers.
      // Claims are off because there is no processing run to resolve them.
      return { lineup: true, freeAgentAdd: true, waiverClaim: false, drop: true, trade: true }
    case PHASE.BLANKET_LOCK:
      // Claims may still be queued — they don't take effect until Tuesday.
      return { lineup: false, freeAgentAdd: false, waiverClaim: true, drop: false, trade: false }
    case PHASE.WAIVER_PERIOD:
      // Rosters and trades reopen, but everyone unrostered is on waivers.
      return { lineup: true, freeAgentAdd: false, waiverClaim: true, drop: true, trade: true }
    case PHASE.OPEN:
      return { lineup: true, freeAgentAdd: true, waiverClaim: true, drop: true, trade: true }
    case PHASE.EARLY_GAME_LOCK:
      // Same permissions as OPEN; the restriction is per-player, not league-wide.
      return { lineup: true, freeAgentAdd: true, waiverClaim: true, drop: true, trade: true }
    default:
      return { lineup: false, freeAgentAdd: false, waiverClaim: false, drop: false, trade: false }
  }
}

function nextDeadline(at, cycle, firstKickoff, phase, seasonStartsAt) {
  // In the preseason the only date that means anything is the first kickoff.
  // Everything else in the cycle is dormant until then.
  if (phase === PHASE.PRESEASON && seasonStartsAt) {
    const kickoff = DateTime.fromISO(seasonStartsAt, { zone: cycle.zone })
    return {
      name: 'season_start',
      title: 'Season kicks off',
      label: label(kickoff),
      at: toIso(kickoff),
    }
  }

  // What's worth counting down to: waivers clearing, the partial lock when the
  // week's first game kicks off, the full lock on Sunday — and, during the
  // full lock, the unlock. Nobody races the unlock, but "when does this end?"
  // is the one question anyone has while rosters are frozen, and counting to
  // Tuesday's waiver run instead made the lock look hours longer than it is.
  const candidates = []

  if (phase === PHASE.BLANKET_LOCK && cycle.weekResetAt > at) {
    candidates.push({ name: 'unlock', title: 'Rosters unlock', at: cycle.weekResetAt })
  }
  if (cycle.waiverProcessAt > at) {
    candidates.push({ name: 'waivers', title: 'Waivers clear', at: cycle.waiverProcessAt })
  }
  if (firstKickoff) {
    const kickoff = DateTime.fromISO(firstKickoff, { zone: cycle.zone })
    if (kickoff > at) candidates.push({ name: 'partial_lock', title: 'Partial lock', at: kickoff })
  }
  candidates.push({ name: 'full_lock', title: 'Full lock', at: cycle.nextBlanketLockAt })

  const next = candidates.filter((c) => c.at > at).sort((a, b) => a.at - b.at)[0]
  return next ? { name: next.name, title: next.title, label: label(next.at), at: toIso(next.at) } : null
}

/** Is this specific player locked right now? */
export function isPlayerLocked(lockState, player) {
  if (lockState.phase === PHASE.BLANKET_LOCK) return true
  const team = player?.nfl_team ?? player?.nflTeam
  if (!team) return false
  return lockState.lockedNflTeams.includes(team) || lockState.inProgressNflTeams.includes(team)
}

export function playerLockReason(lockState, player) {
  if (lockState.phase === PHASE.BLANKET_LOCK) {
    return 'All rosters are locked until the last game of the week finishes.'
  }
  const team = player?.nfl_team ?? player?.nflTeam
  if (!team) return null
  if (lockState.inProgressNflTeams.includes(team)) return `${team} is currently playing.`
  if (lockState.lockedNflTeams.includes(team)) return `${team} has already kicked off this week.`
  return null
}

/** Throws a 409-shaped error if the player can't be moved right now. */
export function assertPlayerMovable(lockState, player, action = 'move') {
  if (isPlayerLocked(lockState, player)) {
    const err = new Error(playerLockReason(lockState, player) || `Cannot ${action} this player right now.`)
    err.status = 409
    err.code = 'PLAYER_LOCKED'
    throw err
  }
}

/** Throws if the phase forbids this class of transaction entirely. */
export function assertAllowed(lockState, capability, message) {
  if (!lockState.allows[capability]) {
    const err = new Error(message || `${PHASE_LABEL[lockState.phase]} — this action is unavailable.`)
    err.status = 409
    err.code = 'PHASE_LOCKED'
    throw err
  }
}
