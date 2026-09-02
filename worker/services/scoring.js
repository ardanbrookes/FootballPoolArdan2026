/**
 * Fantasy scoring, matchup totals, and standings.
 *
 * Points are always computed from raw Sleeper stat lines at read time, so
 * editing `scoring` in config.js retroactively re-scores the season with no
 * backfill. Only players in a week's starting lineup count — bench players score
 * zero by construction, because they simply aren't in the `lineups` table.
 */

import { get, query, batch, stmt } from '../db.js'
import { scoring as defaultScoring, rosterSlots, playoffs } from '../config.js'

/** Dot-product of a Sleeper stat line against the scoring config. */
export function scoreStatLine(stats, scoringConfig = defaultScoring) {
  if (!stats) return 0
  let total = 0
  for (const [key, weight] of Object.entries(scoringConfig)) {
    const value = stats[key]
    if (typeof value === 'number' && Number.isFinite(value)) total += value * weight
  }
  return Math.round(total * 100) / 100
}

/** Map of player_id -> points for one week. */
/**
 * Projected points for a week, keyed by player id.
 *
 * Scored with the same config as real stats, because Sleeper's projection lines
 * use identical stat keys — so a projection is worth exactly what the same real
 * performance would be under this league's half-PPR rules.
 */
/**
 * D1 caps a statement at 100 bound parameters, so a player-id filter is applied
 * in chunks and the results merged.
 */
const ID_CHUNK = 90

/**
 * Build a "WHERE ... AND player_id IN (...)" filter, or no filter at all.
 *
 * Scoping these lookups to the players a request actually cares about is the
 * single biggest saving in the app. Loading the whole week's table to score one
 * roster read ~900 rows per request; a roster needs 17.
 */
function idFilter(ids, offset = 0) {
  const params = {}
  const keys = ids.map((id, i) => {
    params[`id${offset + i}`] = id
    return `@id${offset + i}`
  })
  return { clause: `AND player_id IN (${keys.join(', ')})`, params }
}

/** Run a stats/projections query once per id chunk, or once unfiltered. */
async function selectStatRows(sql, base, playerIds) {
  if (!playerIds) return query(sql.replace('/**IDS**/', ''), base)
  const ids = [...new Set(playerIds)].filter(Boolean)
  if (!ids.length) return []

  const rows = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { clause, params } = idFilter(ids.slice(i, i + ID_CHUNK))
    rows.push(...(await query(sql.replace('/**IDS**/', clause), { ...base, ...params })))
  }
  return rows
}

export async function getWeekProjections(
  season,
  week,
  seasonType = 'regular',
  scoringConfig = defaultScoring,
  { playerIds = null } = {},
) {
  const rows = await selectStatRows(
    `SELECT player_id, stats_json FROM player_projections
      WHERE season = @season AND season_type = @seasonType AND week = @week /**IDS**/`,
    { season, seasonType, week },
    playerIds,
  )

  const points = new Map()
  for (const row of rows) {
    try {
      points.set(row.player_id, scoreStatLine(JSON.parse(row.stats_json), scoringConfig))
    } catch {
      // Skip a malformed line rather than failing the whole lookup.
    }
  }
  return points
}

export async function getWeekPoints(
  season,
  week,
  seasonType = 'regular',
  scoringConfig = defaultScoring,
  { playerIds = null } = {},
) {
  const rows = await selectStatRows(
    `SELECT player_id, stats_json FROM player_stats
      WHERE season = @season AND season_type = @seasonType AND week = @week /**IDS**/`,
    { season, seasonType, week },
    playerIds,
  )
  const points = new Map()
  for (const row of rows) {
    let stats
    try {
      stats = JSON.parse(row.stats_json)
    } catch {
      continue
    }
    points.set(row.player_id, scoreStatLine(stats, scoringConfig))
  }
  return points
}

export async function getPlayerPoints(playerId, season, week, seasonType = 'regular', scoringConfig = defaultScoring) {
  const row = await get(
    `SELECT stats_json FROM player_stats
      WHERE player_id = @playerId AND season = @season AND season_type = @seasonType AND week = @week`,
    { playerId, season, week, seasonType },
  )
  if (!row) return 0
  try {
    return scoreStatLine(JSON.parse(row.stats_json), scoringConfig)
  } catch {
    return 0
  }
}

/**
 * A team's starting lineup for a week, with points. Returns one entry per
 * configured slot so empty slots are visible in the UI.
 */
export async function getLineupWithPoints(leagueId, teamId, season, week, seasonType = 'regular') {
  // Lineup first, so scoring is scoped to at most nine players rather than
  // every player in the league.
  const rows = await query(
    `SELECT l.slot, l.player_id, p.full_name, p.position, p.nfl_team, p.injury_status, p.bye_week
       FROM lineups l
       LEFT JOIN players p ON p.id = l.player_id
      WHERE l.league_id = @leagueId AND l.team_id = @teamId
        AND l.season = @season AND l.week = @week`,
    { leagueId, teamId, season, week },
  )

  const scope = { playerIds: rows.map((r) => r.player_id).filter(Boolean) }
  const [points, projections] = await Promise.all([
    getWeekPoints(season, week, seasonType, defaultScoring, scope),
    getWeekProjections(season, week, seasonType, defaultScoring, scope),
  ])

  const bySlot = new Map(rows.map((r) => [r.slot, r]))

  return rosterSlots.map((config) => {
    const row = bySlot.get(config.slot)
    return {
      slot: config.slot,
      label: config.label,
      eligible: config.eligible,
      player: row?.player_id
        ? {
            id: row.player_id,
            name: row.full_name,
            position: row.position,
            nflTeam: row.nfl_team,
            injuryStatus: row.injury_status,
            byeWeek: row.bye_week,
            points: points.get(row.player_id) ?? 0,
            projectedPoints: projections.get(row.player_id) ?? 0,
          }
        : null,
    }
  })
}

/** Sum of a team's starters for the week. */
export async function scoreTeamWeek(leagueId, teamId, season, week, points) {
  const weekPoints = points || (await getWeekPoints(season, week))
  const starters = await query(
    `SELECT player_id FROM lineups
      WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
        AND week = @week AND player_id IS NOT NULL`,
    { leagueId, teamId, season, week },
  )
  const total = starters.reduce((sum, row) => sum + (weekPoints.get(row.player_id) ?? 0), 0)
  return Math.round(total * 100) / 100
}

/** Recompute both scores for every matchup in a week. */
export async function recalculateMatchups(leagueId, season, week, { markFinal = false } = {}) {
  const [matchups, points] = await Promise.all([
    query(
      `SELECT id, home_team_id, away_team_id FROM matchups
        WHERE league_id = @leagueId AND season = @season AND week = @week`,
      { leagueId, season, week },
    ),
    getWeekPoints(season, week),
  ])

  const writes = []
  for (const matchup of matchups) {
    const [home, away] = await Promise.all([
      scoreTeamWeek(leagueId, matchup.home_team_id, season, week, points),
      scoreTeamWeek(leagueId, matchup.away_team_id, season, week, points),
    ])
    writes.push(
      stmt('UPDATE matchups SET home_score = @home, away_score = @away, status = @status WHERE id = @id', {
        id: matchup.id,
        home,
        away,
        status: markFinal ? 'final' : 'in_progress',
      }),
    )
  }

  await batch(writes)
  return { updated: matchups.length }
}

/**
 * Rebuild W/L/T and points for/against from every final matchup.
 * Idempotent — always recomputed from scratch rather than incremented.
 */
export async function recalculateStandings(leagueId, season) {
  const [teams, finals] = await Promise.all([
    query('SELECT id FROM teams WHERE league_id = @leagueId', { leagueId }),
    // Regular season only. Counting playoff games here would inflate records and
    // — because seeds are derived from these standings — let the bracket's own
    // results re-order the seeds that created it.
    query(
      `SELECT home_team_id, away_team_id, home_score, away_score FROM matchups
        WHERE league_id = @leagueId AND season = @season AND status = 'final'
          AND week <= @regularSeasonWeeks`,
      { leagueId, season, regularSeasonWeeks: playoffs.regularSeasonWeeks },
    ),
  ])

  const tally = new Map(
    teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]),
  )

  for (const m of finals) {
    const home = tally.get(m.home_team_id)
    const away = tally.get(m.away_team_id)
    if (!home || !away) continue

    home.pointsFor += m.home_score
    home.pointsAgainst += m.away_score
    away.pointsFor += m.away_score
    away.pointsAgainst += m.home_score

    if (m.home_score > m.away_score) {
      home.wins += 1
      away.losses += 1
    } else if (m.away_score > m.home_score) {
      away.wins += 1
      home.losses += 1
    } else {
      home.ties += 1
      away.ties += 1
    }
  }

  await batch(
    [...tally].map(([teamId, record]) =>
      stmt(
        `UPDATE teams SET wins = @wins, losses = @losses, ties = @ties,
                          points_for = @pointsFor, points_against = @pointsAgainst
          WHERE id = @teamId`,
        {
          teamId,
          wins: record.wins,
          losses: record.losses,
          ties: record.ties,
          pointsFor: Math.round(record.pointsFor * 100) / 100,
          pointsAgainst: Math.round(record.pointsAgainst * 100) / 100,
        },
      ),
    ),
  )

  return { teams: tally.size }
}

/** Standings ordered by win pct, then points for. */
export function getStandings(leagueId) {
  return query(
    `SELECT t.id, t.name, t.abbreviation, t.logo_url, t.wins, t.losses, t.ties,
            t.points_for, t.points_against, u.display_name AS manager
       FROM teams t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.league_id = @leagueId
      ORDER BY (CAST(t.wins AS REAL) + t.ties * 0.5) /
               CASE WHEN (t.wins + t.losses + t.ties) = 0 THEN 1
                    ELSE (t.wins + t.losses + t.ties) END DESC,
               t.points_for DESC`,
    { leagueId },
  )
}

/**
 * Projected points from `fromWeek` to the end of the regular season.
 *
 * The number that decides a trade: what a player is worth for the rest of the
 * run, not what they might do next Sunday. Summed from the stored weekly
 * projections, so a player on bye simply has no row for that week and
 * contributes nothing — which is the correct answer.
 */
export async function getRestOfSeasonPoints(
  season,
  fromWeek,
  toWeek,
  seasonType = 'regular',
  scoringConfig = defaultScoring,
  { playerIds = null } = {},
) {
  // Read the rollup, not the fourteen weekly rows per player. Summing at read
  // time cost ~2,000 rows to draw one page; this is one row per player.
  const rows = await selectStatRows(
    `SELECT player_id, points FROM player_ros_points
      WHERE season = @season AND season_type = @seasonType
        AND from_week = @fromWeek /**IDS**/`,
    { season, seasonType, fromWeek },
    playerIds,
  )
  return new Map(rows.map((r) => [r.player_id, r.points]))
}

/**
 * Rebuild the rest-of-season rollup from the stored weekly projections.
 *
 * Run once a day, after the weekly projections are refreshed. Reading the
 * weekly rows here is fine — it happens once, not on every page load.
 */
export async function rebuildRestOfSeasonPoints(
  season,
  fromWeek,
  toWeek,
  seasonType = 'regular',
  scoringConfig = defaultScoring,
) {
  const rows = await query(
    `SELECT player_id, stats_json FROM player_projections
      WHERE season = @season AND season_type = @seasonType
        AND week >= @fromWeek AND week <= @toWeek`,
    { season, seasonType, fromWeek, toWeek },
  )

  const totals = new Map()
  for (const row of rows) {
    try {
      const points = scoreStatLine(JSON.parse(row.stats_json), scoringConfig)
      totals.set(row.player_id, (totals.get(row.player_id) ?? 0) + points)
    } catch {
      // Skip a malformed line rather than failing the whole rebuild.
    }
  }

  const writes = [...totals].map(([playerId, value]) =>
    stmt(
      `INSERT INTO player_ros_points (player_id, season, season_type, from_week, points, updated_at)
       VALUES (@playerId, @season, @seasonType, @fromWeek, @points, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (player_id, season, season_type) DO UPDATE SET
         from_week = excluded.from_week, points = excluded.points, updated_at = excluded.updated_at`,
      { playerId, season, seasonType, fromWeek, points: Math.round(value * 10) / 10 },
    ),
  )
  if (writes.length) await batch(writes)
  return { players: writes.length, fromWeek, toWeek }
}
