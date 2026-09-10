/**
 * NFL schedule sync.
 *
 * The Thursday-night lock needs real kickoff timestamps, and Sleeper's public
 * v1 API doesn't expose a schedule (`/schedule/nfl/regular/{season}` 404s), so
 * kickoff times come from ESPN's public scoreboard endpoint.
 *
 * The host matters. `site.api.espn.com` returns 403 to requests from workerd —
 * bot detection on the TLS fingerprint, not something headers can fix — while
 * `site.web.api.espn.com` serves the identical payload and works (the same
 * finding as services/news.js). On the old host every sync in production
 * failed, so every game sat at 'scheduled' however long ago it was played.
 *
 * The schedule of record is loaded from a generated SQL file — see
 * scripts/build-schedule.mjs — so this module only refreshes live game status.
 * Callers must tolerate it throwing. Nothing reads a raw status either:
 * `getWeekGames` blends it with the kickoff time, so a bad day at ESPN costs
 * the LIVE/FINAL labels some precision rather than breaking the scoreboard.
 *
 * Team codes are normalised to Sleeper's abbreviations so `nfl_games.home_team`
 * always joins cleanly against `players.nfl_team`.
 */

import { query, batch, stmt } from '../db.js'
import { recordSync } from './sleeper.js'
import { GAME_DURATION_HOURS } from '../config.js'

const ESPN_SCOREBOARD = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'

/** ESPN abbreviation -> Sleeper abbreviation. Only the ones that differ. */
const TEAM_CODE_MAP = { WSH: 'WAS' }

const SEASON_TYPE_TO_ESPN = { preseason: 1, regular: 2, post: 3, postseason: 3 }

/** How long ESPN's word that a game is live outranks the clock. */
const LIVE_REPORT_TRUST_HOURS = 6

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
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`)
  return res.json()
}

/**
 * Sync a single week's games.
 *
 * Only rows that actually changed are written. This runs every 15 minutes
 * while games are on, and rewriting sixteen unchanged rows each time would be
 * write allowance spent on nothing.
 */
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
                       updated_at = excluded.updated_at
          WHERE nfl_games.status != excluded.status
             OR nfl_games.kickoff_at != excluded.kickoff_at`,
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
 * A game's status: ESPN's where it has spoken, the clock's where it hasn't.
 *
 * The stored status only moves when a sync succeeds, and for a while none did —
 * a game finished on Wednesday still read 'scheduled' on Thursday, so every
 * player in it showed a projection instead of a score. Kickoff times are
 * reliable, so past kickoff a game is live and past a normal game's length it
 * is over. A live report from ESPN outranks that for a few hours, covering
 * overtime and weather delays; after that, a status still stuck on live is a
 * sync that stopped, not a game that didn't.
 */
export function effectiveStatus(game, nowMs = Date.now()) {
  if (game.status === 'final') return 'final'
  const kickoff = Date.parse(game.kickoff_at)
  if (!Number.isFinite(kickoff) || nowMs < kickoff) return 'scheduled'

  const hours = (nowMs - kickoff) / 3_600_000
  if (game.status === 'in_progress' && hours < LIVE_REPORT_TRUST_HOURS) return 'in_progress'
  return hours < GAME_DURATION_HOURS ? 'in_progress' : 'final'
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

/** A week's games, each carrying its effective status rather than the stored one. */
export async function getWeekGames(season, week, seasonType = 'regular') {
  const games = await query(
    `SELECT id, week, home_team, away_team, kickoff_at, status
       FROM nfl_games
      WHERE season = @season AND season_type = @seasonType AND week = @week
      ORDER BY kickoff_at ASC`,
    { season, seasonType, week },
  )
  const nowMs = Date.now()
  return games.map((game) => ({ ...game, status: effectiveStatus(game, nowMs) }))
}
