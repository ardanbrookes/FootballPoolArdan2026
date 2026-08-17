/**
 * NFL schedule sync.
 *
 * The Thursday-night lock needs real kickoff timestamps, and Sleeper's public
 * v1 API doesn't expose a schedule (`/schedule/nfl/regular/{season}` 404s), so
 * kickoff times come from ESPN's public scoreboard endpoint.
 *
 * IMPORTANT: ESPN returns 403 to requests originating from workerd, so these
 * functions generally FAIL in production. Identical requests from Node succeed,
 * and Sleeper works fine from the Worker, so this is ESPN bot-detection on the
 * TLS fingerprint rather than anything headers can fix.
 *
 * The schedule of record is therefore loaded from a generated SQL file — see
 * scripts/build-schedule.mjs — and this module is kept only as a best-effort
 * refresh for live game status. Callers must tolerate it throwing; nothing that
 * matters depends on it succeeding.
 *
 * Team codes are normalised to Sleeper's abbreviations so `nfl_games.home_team`
 * always joins cleanly against `players.nfl_team`.
 */

import { query, batch, stmt } from '../db.js'
import { recordSync } from './sleeper.js'

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'

/** ESPN abbreviation -> Sleeper abbreviation. Only the ones that differ. */
const TEAM_CODE_MAP = { WSH: 'WAS' }

const SEASON_TYPE_TO_ESPN = { preseason: 1, regular: 2, post: 3, postseason: 3 }

export function normalizeTeam(code) {
  if (!code) return null
  const upper = String(code).toUpperCase()
  return TEAM_CODE_MAP[upper] || upper
}

function mapStatus(espnStatusName) {
  switch (espnStatusName) {
    case 'STATUS_FINAL':
      return 'final'
    case 'STATUS_IN_PROGRESS':
    case 'STATUS_HALFTIME':
    case 'STATUS_END_PERIOD':
      return 'in_progress'
    default:
      return 'scheduled'
  }
}

async function fetchWeek(season, week, seasonType) {
  const type = SEASON_TYPE_TO_ESPN[seasonType] ?? 2
  const url = `${ESPN_SCOREBOARD}?dates=${season}&seasontype=${type}&week=${week}`
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      // ESPN 403s workerd's default user-agent. A browser-shaped one is
      // accepted; without this every schedule sync silently returns zero games
      // and the Thursday-night lock has nothing to key off.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`)
  return res.json()
}

/** Sync a single week's games. */
export async function syncWeek(season, week, seasonType = 'regular') {
  const data = await fetchWeek(season, week, seasonType)
  const writes = []

  for (const event of data?.events || []) {
    const competition = event.competitions?.[0]
    if (!competition) continue

    const home = competition.competitors?.find((c) => c.homeAway === 'home')
    const away = competition.competitors?.find((c) => c.homeAway === 'away')
    if (!home || !away) continue

    const kickoff = new Date(event.date)
    if (Number.isNaN(kickoff.valueOf())) continue

    writes.push(
      stmt(
        `INSERT INTO nfl_games (season, season_type, week, home_team, away_team, kickoff_at, status, updated_at)
         VALUES (@season, @seasonType, @week, @home, @away, @kickoff, @status,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (season, season_type, week, home_team, away_team)
         DO UPDATE SET kickoff_at = excluded.kickoff_at,
                       status = excluded.status,
                       updated_at = excluded.updated_at`,
        {
          season,
          seasonType,
          week,
          home: normalizeTeam(home.team?.abbreviation),
          away: normalizeTeam(away.team?.abbreviation),
          kickoff: kickoff.toISOString(),
          status: mapStatus(competition.status?.type?.name || event.status?.type?.name),
        },
      ),
    )
  }

  await batch(writes)
  return { week, games: writes.length }
}

/** Sync a range of weeks. Failures on individual weeks don't abort the run. */
export async function syncSeason(season, { seasonType = 'regular', fromWeek = 1, toWeek = 18 } = {}) {
  const results = []
  const errors = []

  for (let week = fromWeek; week <= toWeek; week += 1) {
    try {
      results.push(await syncWeek(season, week, seasonType))
    } catch (err) {
      errors.push({ week, message: err.message })
    }
  }

  const total = results.reduce((sum, r) => sum + r.games, 0)
  await recordSync(
    `schedule:${season}:${seasonType}`,
    errors.length ? 'partial' : 'ok',
    `${total} games across ${results.length} weeks${errors.length ? `; ${errors.length} weeks failed` : ''}`,
  )

  return { total, weeks: results, errors }
}

/**
 * Where each NFL team's game stands this week, keyed by team abbreviation.
 *
 * Powers the Sunday scoreboard: a player's score only means something alongside
 * whether their game hasn't started, is in progress, or is done.
 *
 * @returns {Promise<Map<string, {status: string, kickoffAt: string, opponent: string, isHome: boolean}>>}
 */
export async function getTeamGameStatus(season, week, seasonType = 'regular') {
  const games = await getWeekGames(season, week, seasonType)
  const byTeam = new Map()

  for (const game of games) {
    byTeam.set(game.home_team, {
      status: game.status,
      kickoffAt: game.kickoff_at,
      opponent: game.away_team,
      isHome: true,
    })
    byTeam.set(game.away_team, {
      status: game.status,
      kickoffAt: game.kickoff_at,
      opponent: game.home_team,
      isHome: false,
    })
  }

  return byTeam
}

export function getWeekGames(season, week, seasonType = 'regular') {
  return query(
    `SELECT id, week, home_team, away_team, kickoff_at, status
       FROM nfl_games
      WHERE season = @season AND season_type = @seasonType AND week = @week
      ORDER BY kickoff_at ASC`,
    { season, seasonType, week },
  )
}
