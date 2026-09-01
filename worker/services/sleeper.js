/**
 * Sleeper API client + sync.
 *
 * Sleeper's public v1 API needs no key. We use it for:
 *   GET /state/nfl                          current season + week
 *   GET /players/nfl                        the full player dictionary (~5MB)
 *   GET /stats/nfl/{type}/{season}/{week}    weekly stat lines
 *
 * Sleeper v1 does NOT publish a game schedule with kickoff times, which the
 * Thursday-night lock depends on — see services/schedule.js for that piece.
 */

import { get, query, run, batch, stmt, nowIso } from '../db.js'
import { getSleeperConfig } from '../config.js'

const USER_AGENT = 'FootballPoolArdan2026/0.1 (+league app)'

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`Sleeper ${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

export function fetchState() {
  const { baseUrl, sport } = getSleeperConfig()
  return fetchJson(`${baseUrl}/state/${sport}`)
}

export function fetchAllPlayers() {
  const { baseUrl, sport } = getSleeperConfig()
  return fetchJson(`${baseUrl}/players/${sport}`)
}

export function fetchWeekStats(season, week, seasonType = 'regular') {
  const { baseUrl, sport } = getSleeperConfig()
  return fetchJson(`${baseUrl}/stats/${sport}/${seasonType}/${season}/${week}`)
}

/** Positions we care about. Sleeper's dump includes every practice-squad body in the league. */
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])

function shouldKeep(player) {
  if (!player) return false
  const positions = player.fantasy_positions || []
  const relevant = positions.some((p) => FANTASY_POSITIONS.has(p)) || FANTASY_POSITIONS.has(player.position)
  if (!relevant) return false

  // All 32 team defenses, always.
  if (player.position === 'DEF') return true

  // Must be on an NFL roster. Sleeper keeps retired players in the dump with
  // low search_rank values — Brady and Gronkowski would otherwise show up at
  // the top of the free agent list. Anyone who signs mid-season gets picked up
  // by the next daily sync.
  return Boolean(player.team)
}

function displayName(player) {
  if (player.position === 'DEF') return `${player.team || player.player_id} D/ST`
  return player.full_name || [player.first_name, player.last_name].filter(Boolean).join(' ') || player.player_id
}

const UPSERT_PLAYER_SQL = `
  INSERT INTO players (
    id, full_name, first_name, last_name, position, fantasy_positions, nfl_team,
    jersey_number, status, injury_status, bye_week, years_exp, search_rank, age, updated_at
  ) VALUES (
    @id, @fullName, @firstName, @lastName, @position, @fantasyPositions, @nflTeam,
    @jerseyNumber, @status, @injuryStatus, @byeWeek, @yearsExp, @searchRank, @age,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = excluded.full_name,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    position = excluded.position,
    fantasy_positions = excluded.fantasy_positions,
    nfl_team = excluded.nfl_team,
    jersey_number = excluded.jersey_number,
    status = excluded.status,
    injury_status = excluded.injury_status,
    bye_week = excluded.bye_week,
    years_exp = excluded.years_exp,
    search_rank = excluded.search_rank,
    age = excluded.age,
    updated_at = excluded.updated_at`

/** D1 caps how many statements one batch can carry. */
const CHUNK = 200

/**
 * Pull the player dictionary into the `players` table.
 * Skipped if it ran within the configured TTL unless `force` is set.
 */
export async function syncPlayers({ force = false } = {}) {
  const { playerTtlHours } = getSleeperConfig()
  const last = await get("SELECT last_run_at FROM sync_log WHERE key = 'players'")
  if (!force && last) {
    const ageHours = (Date.now() - Date.parse(last.last_run_at)) / 3_600_000
    if (ageHours < playerTtlHours) return { skipped: true, ageHours: Number(ageHours.toFixed(1)) }
  }

  const all = await fetchAllPlayers()
  const rows = Object.values(all).filter(shouldKeep)

  for (let i = 0; i < rows.length; i += CHUNK) {
    await batch(
      rows.slice(i, i + CHUNK).map((p) =>
        stmt(UPSERT_PLAYER_SQL, {
          id: String(p.player_id),
          fullName: displayName(p),
          firstName: p.first_name ?? null,
          lastName: p.last_name ?? null,
          position: p.position ?? null,
          fantasyPositions: JSON.stringify(p.fantasy_positions || []),
          nflTeam: p.team ?? null,
          jerseyNumber: Number.isFinite(p.number) ? p.number : null,
          status: p.status ?? null,
          injuryStatus: p.injury_status ?? null,
          byeWeek: Number.isFinite(Number(p.bye_week)) ? Number(p.bye_week) : null,
          yearsExp: Number.isFinite(p.years_exp) ? p.years_exp : null,
          searchRank: Number.isFinite(p.search_rank) ? p.search_rank : 999999,
          age: Number.isFinite(p.age) ? p.age : null,
        }),
      ),
    )
  }

  const pruned = await prunePlayers(rows.map((p) => String(p.player_id)))
  await recordSync('players', 'ok', `${rows.length} players, ${pruned} pruned`)
  return { skipped: false, count: rows.length, pruned }
}

/**
 * Drop stored players who no longer belong in the pool (retired, cut, position
 * change). Rostered players are never removed — the FK cascade would silently
 * strip them from someone's team — so they linger until dropped.
 */
async function prunePlayers(keepIds) {
  const keep = new Set(keepIds)
  const stale = (
    await query(
      `SELECT p.id FROM players p
        LEFT JOIN roster_players rp ON rp.player_id = p.id
       WHERE rp.player_id IS NULL`,
    )
  ).filter((row) => !keep.has(row.id))

  for (let i = 0; i < stale.length; i += CHUNK) {
    await batch(stale.slice(i, i + CHUNK).map((row) => stmt('DELETE FROM players WHERE id = @id', { id: row.id })))
  }
  return stale.length
}

/** Pull one week of stat lines. Points are computed later from league scoring. */
export async function syncWeekStats(season, week, seasonType = 'regular') {
  const stats = await fetchWeekStats(season, week, seasonType)
  const knownIds = new Set((await query('SELECT id FROM players')).map((r) => r.id))

  const entries = Object.entries(stats || {}).filter(([playerId]) => knownIds.has(playerId))
  for (let i = 0; i < entries.length; i += CHUNK) {
    await batch(
      entries.slice(i, i + CHUNK).map(([playerId, line]) =>
        stmt(
          `INSERT INTO player_stats (player_id, season, season_type, week, stats_json, updated_at)
           VALUES (@playerId, @season, @seasonType, @week, @stats, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (player_id, season, season_type, week)
           DO UPDATE SET stats_json = excluded.stats_json, updated_at = excluded.updated_at`,
          { playerId, season, seasonType, week, stats: JSON.stringify(line ?? {}) },
        ),
      ),
    )
  }

  await recordSync(`stats:${season}:${seasonType}:${week}`, 'ok', `${entries.length} stat lines`)
  return { count: entries.length }
}

/**
 * Cache a week of projections.
 *
 * Sleeper uses the same stat keys for projections as for real stats, so the
 * league's own scoring config turns a projection into projected points with no
 * extra mapping — a projected 6 catches is worth 3 points here, same as 6 real
 * ones would be.
 */
export async function syncWeekProjections(season, week, seasonType = 'regular') {
  const { baseUrl, sport } = getSleeperConfig()
  const projections = await fetchJson(`${baseUrl}/projections/${sport}/${seasonType}/${season}/${week}`)

  const knownIds = new Set((await query('SELECT id FROM players')).map((r) => r.id))
  const writes = []

  for (const [playerId, line] of Object.entries(projections || {})) {
    if (!knownIds.has(playerId)) continue
    writes.push(
      stmt(
        `INSERT INTO player_projections (player_id, season, season_type, week, stats_json, updated_at)
         VALUES (@playerId, @season, @seasonType, @week, @stats, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (player_id, season, season_type, week)
         DO UPDATE SET stats_json = excluded.stats_json, updated_at = excluded.updated_at`,
        { playerId, season, seasonType, week, stats: JSON.stringify(line ?? {}) },
      ),
    )
  }

  if (writes.length) await batch(writes)
  await recordSync(`projections:${season}:${seasonType}:${week}`, 'ok', `${writes.length} projections`)
  return { count: writes.length }
}

export function recordSync(key, status = 'ok', detail = null) {
  return run(
    `INSERT INTO sync_log (key, last_run_at, status, detail)
     VALUES (@key, @at, @status, @detail)
     ON CONFLICT (key) DO UPDATE SET last_run_at = excluded.last_run_at,
                                    status = excluded.status,
                                    detail = excluded.detail`,
    { key, at: nowIso(), status, detail },
  )
}

export function getSyncLog() {
  return query('SELECT key, last_run_at, status, detail FROM sync_log ORDER BY last_run_at DESC')
}

export function getSyncEntry(key) {
  return get('SELECT key, last_run_at, status, detail FROM sync_log WHERE key = @key', { key })
}

/**
 * Keep projections for the rest of the regular season, not just this week.
 *
 * "Projected rest of season" is the number that actually decides a trade, and
 * it can only be summed if the weeks are stored. Sleeper does publish a
 * season-long endpoint, but it returns a full-season total — no use once
 * you're at week 6 and want what's left.
 *
 * Future weeks barely move, so each is refreshed at most every `maxAgeHours`.
 * That keeps the daily job cheap: the first run fetches the whole remaining
 * season, later ones usually fetch nothing.
 */
export async function syncRestOfSeasonProjections(
  season,
  fromWeek,
  toWeek,
  seasonType = 'regular',
  { maxAgeHours = 72 } = {},
) {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString()
  const synced = []
  const skipped = []

  for (let week = fromWeek; week <= toWeek; week++) {
    const key = `projections:${season}:${seasonType}:${week}`
    const entry = await getSyncEntry(key)
    // The current week is refreshed constantly by the stats job; leave it be.
    if (week !== fromWeek && entry && entry.last_run_at > cutoff) {
      skipped.push(week)
      continue
    }
    try {
      const { count } = await syncWeekProjections(season, week, seasonType)
      synced.push({ week, count })
    } catch (err) {
      // A week with no projections published yet is normal, not a failure.
      console.warn(`[sync] projections unavailable for week ${week}: ${err.message}`)
    }
  }

  return { synced: synced.length, skipped: skipped.length, weeks: synced }
}
