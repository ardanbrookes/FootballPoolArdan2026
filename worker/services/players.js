/**
 * Player pool: availability and search.
 *
 * A player is in exactly one of three states within a league:
 *   ROSTERED    on someone's roster
 *   WAIVERS     unrostered, and now() < waivers_clear_at — claim only
 *   FREE_AGENT  unrostered and cleared — first come, first served
 *
 * State is derived, never stored directly, so it can't drift out of sync with
 * `roster_players`.
 */

import { get, query, run, batch, stmt, nowIso } from '../db.js'
import { getCycle, now as clockNow, toIso } from './clock.js'
import { getTiming } from './settings.js'

export const AVAILABILITY = {
  ROSTERED: 'rostered',
  WAIVERS: 'waivers',
  FREE_AGENT: 'free_agent',
}

/**
 * SQL fragment computing availability. Kept in one place so the list view and
 * the single-player lookup can never disagree.
 */
const AVAILABILITY_SELECT = `
  CASE
    WHEN rp.team_id IS NOT NULL THEN 'rostered'
    WHEN pps.waivers_clear_at IS NOT NULL AND pps.waivers_clear_at > @now THEN 'waivers'
    ELSE 'free_agent'
  END AS availability`

export function getPlayer(playerId) {
  return get('SELECT * FROM players WHERE id = @playerId', { playerId })
}

export function getPlayerWithAvailability(leagueId, playerId) {
  return get(
    `SELECT p.*, rp.team_id AS owner_team_id, t.name AS owner_team_name,
            pps.waivers_clear_at, ${AVAILABILITY_SELECT}
       FROM players p
       LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
       LEFT JOIN teams t ON t.id = rp.team_id
       LEFT JOIN player_pool_state pps ON pps.player_id = p.id AND pps.league_id = @leagueId
      WHERE p.id = @playerId`,
    { leagueId, playerId, now: nowIso() },
  )
}

/** Search the pool. */
export function searchPlayers(leagueId, opts = {}) {
  const {
    search,
    position,
    availability,
    limit = 50,
    offset = 0,
    // Set to include watchlist state (and optionally filter to it).
    userId = null,
    watchedOnly = false,
  } = opts

  const where = ['1=1']
  const params = { leagueId, now: nowIso(), limit: Math.min(limit, 200), offset, userId }

  if (search) {
    where.push('p.full_name LIKE @search')
    params.search = `%${search}%`
  }
  if (position) {
    where.push('(p.position = @position OR p.fantasy_positions LIKE @positionJson)')
    params.position = position
    params.positionJson = `%"${position}"%`
  }
  // Filtering on the join is cheaper than filtering the computed column later.
  if (watchedOnly && userId) where.push('w.player_id IS NOT NULL')

  // Availability is a computed column, so it has to be filtered in a wrapper.
  const inner = `
    SELECT p.id, p.full_name, p.position, p.fantasy_positions, p.nfl_team, p.injury_status,
           p.status, p.bye_week, p.search_rank, p.jersey_number,
           rp.team_id AS owner_team_id, t.name AS owner_team_name, t.abbreviation AS owner_team_abbr,
           pps.waivers_clear_at,
           CASE WHEN w.player_id IS NULL THEN 0 ELSE 1 END AS watched,
           ${AVAILABILITY_SELECT}
      FROM players p
      LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
      LEFT JOIN teams t ON t.id = rp.team_id
      LEFT JOIN player_pool_state pps ON pps.player_id = p.id AND pps.league_id = @leagueId
      LEFT JOIN watchlist w ON w.player_id = p.id AND w.league_id = @leagueId AND w.user_id = @userId
     WHERE ${where.join(' AND ')}`

  const availabilityFilter = availability ? 'WHERE availability = @availability' : ''
  if (availability) params.availability = availability

  return query(
    `SELECT * FROM (${inner}) ${availabilityFilter}
      ORDER BY search_rank ASC, full_name ASC
      LIMIT @limit OFFSET @offset`,
    params,
  )
}

/** Add or remove a player from the signed-in manager's watchlist. */
export async function setWatchlist({ leagueId, userId, playerId, watched }) {
  if (watched) {
    await run(
      `INSERT INTO watchlist (league_id, user_id, player_id) VALUES (@leagueId, @userId, @playerId)
       ON CONFLICT (league_id, user_id, player_id) DO NOTHING`,
      { leagueId, userId, playerId },
    )
  } else {
    await run(
      'DELETE FROM watchlist WHERE league_id = @leagueId AND user_id = @userId AND player_id = @playerId',
      { leagueId, userId, playerId },
    )
  }
  return { playerId, watched: Boolean(watched) }
}

const PLACE_ON_WAIVERS_SQL = `
  INSERT INTO player_pool_state (league_id, player_id, waivers_clear_at, updated_at)
  VALUES (@leagueId, @playerId, @clearAt, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT (league_id, player_id)
  DO UPDATE SET waivers_clear_at = excluded.waivers_clear_at, updated_at = excluded.updated_at`

const CLEAR_WAIVER_SQL =
  'DELETE FROM player_pool_state WHERE league_id = @leagueId AND player_id = @playerId'

/** Statement forms, for callers assembling a batch. */
export const statements = {
  placeOnWaivers: (leagueId, playerId, clearAt) =>
    stmt(PLACE_ON_WAIVERS_SQL, { leagueId, playerId, clearAt }),
  clearWaiverState: (leagueId, playerId) => stmt(CLEAR_WAIVER_SQL, { leagueId, playerId }),
}

/** Put a player on waivers until the next processing time. */
export function placeOnWaivers(leagueId, playerId, clearAtIso) {
  return run(PLACE_ON_WAIVERS_SQL, { leagueId, playerId, clearAt: clearAtIso })
}

/** Clear waiver state — the player becomes a free agent (or is now rostered). */
export function clearWaiverState(leagueId, playerId) {
  return run(CLEAR_WAIVER_SQL, { leagueId, playerId })
}

/** The instant a player dropped right now would clear waivers. */
export async function nextWaiverClearTime(leagueId, ref) {
  const timing = await getTiming(leagueId)
  const at = ref || clockNow(timing.timezone)
  const cycle = getCycle(at, timing)
  // If this week's processing has already happened, the player waits for next week's.
  const target =
    at < cycle.waiverProcessAt ? cycle.waiverProcessAt : cycle.waiverProcessAt.plus({ weeks: 1 })
  return toIso(target)
}

/**
 * Weekly reset: every unrostered player goes back on waivers until processing.
 *
 * This touches thousands of rows, so it is chunked — D1 caps how many
 * statements one batch may carry.
 */
export async function resetPoolToWaivers(leagueId, clearAtIso) {
  const unrostered = await query(
    `SELECT p.id FROM players p
      LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
     WHERE rp.team_id IS NULL`,
    { leagueId },
  )

  const CHUNK = 200
  for (let i = 0; i < unrostered.length; i += CHUNK) {
    await batch(
      unrostered
        .slice(i, i + CHUNK)
        .map((row) => statements.placeOnWaivers(leagueId, row.id, clearAtIso)),
    )
  }

  return { count: unrostered.length }
}

/**
 * Put every unrostered player on the given NFL teams on waivers.
 *
 * Called as each pre-Sunday game kicks off. A player whose game has started
 * is locked, so as a "free agent" nobody could actually add him — he sat in
 * limbo until the Sunday lock moved everyone to waivers. On waivers he can be
 * claimed straight away, resolving at the next processing run like any other
 * claim.
 *
 * Players already on waivers keep their clear time; only free agents move.
 */
export async function placeTeamsOnWaivers(leagueId, nflTeams, clearAtIso) {
  if (!nflTeams.length) return { count: 0 }

  const params = { leagueId, clearAt: clearAtIso, now: nowIso() }
  const placeholders = nflTeams.map((team, i) => {
    params[`team${i}`] = team
    return `@team${i}`
  })

  const result = await run(
    `INSERT INTO player_pool_state (league_id, player_id, waivers_clear_at, updated_at)
     SELECT @leagueId, p.id, @clearAt, strftime('%Y-%m-%dT%H:%M:%fZ','now')
       FROM players p
       LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
      WHERE p.nfl_team IN (${placeholders.join(', ')}) AND rp.team_id IS NULL
     ON CONFLICT (league_id, player_id)
     DO UPDATE SET waivers_clear_at = excluded.waivers_clear_at, updated_at = excluded.updated_at
      WHERE player_pool_state.waivers_clear_at IS NULL OR player_pool_state.waivers_clear_at <= @now`,
    params,
  )
  return { count: result?.changes ?? 0 }
}
