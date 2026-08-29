/**
 * League configuration.
 *
 * Static shape (roster slots, scoring) lives here as constants. Anything a
 * commissioner might tune reads from Worker `vars`, which come from
 * wrangler.toml in production and .dev.vars locally. Per-league overrides on top
 * of these live in the `league_settings` table — see services/settings.js.
 *
 * Weekdays follow Luxon's convention: 1 = Monday ... 7 = Sunday.
 */

import { getEnv } from './context.js'

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function getServerConfig() {
  const env = getEnv()
  return {
    sessionSecret: env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    adminToken: env.ADMIN_TOKEN || null,
    sessionTtlDays: 30,
    isProduction: env.ENVIRONMENT === 'production',
  }
}

export function getSleeperConfig() {
  const env = getEnv()
  return {
    baseUrl: env.SLEEPER_BASE_URL || 'https://api.sleeper.app/v1',
    playerTtlHours: int(env.SLEEPER_PLAYER_TTL_HOURS, 24),
    sport: 'nfl',
  }
}

/**
 * The weekly cycle, as the league runs it.
 *
 *   Sun 10:00      blanketLock    every roster freezes, trades close, and any
 *                                 remaining free agents go on waivers
 *   Mon late       weekReset      the last game ends -> rosters unlock, standings
 *                                 update, trades reopen, claims can be queued
 *   Tue 03:00      waiverProcess  claims resolve; everyone unclaimed becomes a
 *                                 free agent and the open window begins
 *   Thu kickoff    (derived)      only the two teams playing lock
 *
 * `weekReset` is deliberately NOT a clock time. "After the last game concludes"
 * means Monday night, but MNF kickoff moves around and games run long, so the
 * boundary is derived from the actual schedule — see services/clock.js. The
 * fallback only applies if the schedule hasn't been synced.
 *
 * Times are in LEAGUE_TIMEZONE. America/Vancouver tracks Pacific DST
 * automatically, so 3:00am stays 3:00am local all season.
 */
export function getTimingConfig() {
  const env = getEnv()
  return {
    timezone: env.LEAGUE_TIMEZONE || 'America/Vancouver',

    waiverProcess: {
      weekday: int(env.WAIVER_PROCESS_WEEKDAY, 2), // Tuesday
      hour: int(env.WAIVER_PROCESS_HOUR, 3), // 3:00 AM Pacific
      minute: int(env.WAIVER_PROCESS_MINUTE, 0),
    },

    blanketLock: {
      weekday: int(env.BLANKET_LOCK_WEEKDAY, 7), // Sunday
      hour: int(env.BLANKET_LOCK_HOUR, 10), // 10:00 AM Pacific — early-window kickoff
      minute: int(env.BLANKET_LOCK_MINUTE, 0),
    },

    weekReset: {
      /** 'after_last_game' derives from the schedule; 'fixed' uses `fallback`. */
      mode: env.WEEK_RESET_MODE || 'after_last_game',
      /** Grace period after the final whistle before rosters open. */
      bufferMinutes: int(env.WEEK_RESET_BUFFER_MINUTES, 30),
      /** Used only when the week's games aren't in the database. */
      fallback: {
        weekday: int(env.WEEK_RESET_WEEKDAY, 2), // Tuesday
        hour: int(env.WEEK_RESET_HOUR, 0), // just after midnight
        minute: int(env.WEEK_RESET_MINUTE, 0),
      },
    },
  }
}

/** Assumed length of an NFL game, for "is this game still going?" decisions. */
export const GAME_DURATION_HOURS = 3.5

/**
 * Starting lineup. Order here is the order shown in the UI.
 * `eligible` lists the Sleeper fantasy positions allowed in the slot.
 * Remove a line to drop the slot from the league — nothing else needs to change.
 */
export const rosterSlots = [
  { slot: 'QB', label: 'QB', eligible: ['QB'] },
  { slot: 'RB1', label: 'RB', eligible: ['RB'] },
  { slot: 'RB2', label: 'RB', eligible: ['RB'] },
  { slot: 'WR1', label: 'WR', eligible: ['WR'] },
  { slot: 'WR2', label: 'WR', eligible: ['WR'] },
  { slot: 'TE', label: 'TE', eligible: ['TE'] },
  { slot: 'FLEX', label: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  { slot: 'DEF', label: 'D/ST', eligible: ['DEF'] },
  { slot: 'K', label: 'K', eligible: ['K'] },
]

export const roster = {
  benchSize: 7,
  /**
   * Injured-reserve slots. A player parked here doesn't count against the roster
   * limit, so you can hold an injured player without burning a bench spot — but
   * they can't be started, and they score nothing.
   */
  irSlots: 1,
  /**
   * Injury designations that qualify for IR. Anything less severe than these
   * (notably Questionable) would turn IR into a free extra bench spot.
   */
  irEligibleStatuses: ['IR', 'Out', 'PUP', 'Suspended', 'Doubtful', 'DNR', 'NA', 'COV'],
  starterCount: rosterSlots.length,
  get maxPlayers() {
    return rosterSlots.length + this.benchSize
  },
}

export const waivers = {
  /** Time Since Last Claim: longest without a win picks first. */
  priorityMode: 'tslc',
  maxClaimsPerTeam: 10,
  /** Winning resets your clock, dropping you to the back of the order. */
  resetPriorityOnWin: true,
}

/**
 * Season shape and playoffs.
 *
 * Fourteen regular-season weeks, then a four-team bracket:
 *
 *   Week 15  Semifinals   1 v 4  and  2 v 3, higher seed hosts
 *   Week 16  Final        winners meet
 *
 * Single elimination each round. A tie advances the higher seed, so the regular
 * season always breaks a deadlock rather than leaving one.
 */
export const playoffs = {
  regularSeasonWeeks: 14,
  /** How many teams reach the bracket. */
  teams: 4,
  /** Rounds in order. `pairings` are seed numbers, higher seed first (hosts). */
  rounds: [
    { week: 15, name: 'Semifinals', pairings: [[1, 4], [2, 3]] },
    { week: 16, name: 'Final' },
  ],
  /** Standings order: win pct first, then total points as the tiebreaker. */
  seedBy: ['winPct', 'pointsFor'],
}

/** Every week the playoffs occupy. */
export const playoffWeeks = playoffs.rounds.map((r) => r.week)

/**
 * Standard half-PPR. Keys are Sleeper's stat keys; points are the dot product of
 * a player's stat line with this table, computed at read time so editing these
 * values re-scores the whole season with no backfill.
 *
 * Half PPR means 0.5 per catch — the only thing separating this from standard
 * scoring, and the reason a target-heavy receiver is worth a little more here
 * than in a non-PPR league and a little less than in full PPR.
 */
export const scoring = {
  // --- Passing --- 1 point per 25 yards
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_2pt: 2,

  // --- Rushing --- 1 point per 10 yards
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,

  // --- Receiving --- 1 point per 10 yards, half a point per catch
  rec: 0.5,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,

  // --- Turnovers ---
  fum_lost: -2,

  // --- Kicking --- longer field goals are worth more
  fgm_0_19: 3,
  fgm_20_29: 3,
  fgm_30_39: 3,
  fgm_40_49: 4,
  fgm_50p: 5,
  fgmiss: -1,
  xpm: 1,
  xpmiss: -1,

  // --- Team defence ---
  def_td: 6,
  sack: 1,
  int: 2,
  fum_rec: 2,
  safe: 2,
  blk_kick: 2,

  // Points allowed, banded. Sleeper sets exactly one of these per game.
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
}

/**
 * How much a starter's score swings week to week, by position, in points.
 *
 * Used only by the win-probability model. These are rough half-PPR weekly
 * standard deviations, not measurements from this league — a receiver who
 * catches one deep ball is a genuinely wilder ride than a kicker, and the model
 * only needs to know roughly by how much.
 *
 * Keyed on real position, so a WR in the FLEX carries WR volatility.
 */
export const positionVariance = {
  QB: 7.0,
  RB: 6.5,
  WR: 7.0,
  TE: 5.0,
  K: 3.5,
  DEF: 6.0,
}

/** Fallback for anything unrecognised. */
export const defaultPositionSd = 6.0
