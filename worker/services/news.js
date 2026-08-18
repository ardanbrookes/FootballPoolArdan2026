/**
 * NFL news feed.
 *
 * Source is ESPN's news API, which tags every article with the athletes and
 * teams it is about. That editorial tagging is the whole reason this feature
 * works: "show me news about my roster" is a join, not a guess.
 *
 * THE HOST IS LOAD-BEARING. ESPN serves the same payload from two hosts:
 *
 *   site.api.espn.com      403s from workerd (see services/schedule.js)
 *   site.web.api.espn.com  200s from workerd
 *
 * Only the second is usable in production. They return identical article
 * structures, so if this starts failing, check the host before assuming the
 * API changed.
 *
 * ESPN only ever returns the 50 most recent articles per feed, so ingest
 * accumulates into `news_articles` rather than replacing it — the archive is
 * ours, the feed is just a window onto what is new.
 */

import { query, run, batch, stmt, nowIso } from '../db.js'

const NEWS_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news'
const USER_AGENT = 'Mozilla/5.0 (compatible; FootballPoolArdan2026/0.1)'

/** D1 rejects a statement carrying more than 100 bound parameters. */
const CHUNK = 90

/** ESPN numeric team id -> our abbreviation. ESPN says WSH, we say WAS. */
export const ESPN_TEAM_IDS = {
  ARI: 22, ATL: 1, BAL: 33, BUF: 2, CAR: 29, CHI: 3, CIN: 4, CLE: 5,
  DAL: 6, DEN: 7, DET: 8, GB: 9, HOU: 34, IND: 11, JAX: 30, KC: 12,
  LAC: 24, LAR: 14, LV: 13, MIA: 15, MIN: 16, NE: 17, NO: 18, NYG: 19,
  NYJ: 20, PHI: 21, PIT: 23, SEA: 26, SF: 25, TB: 27, TEN: 10, WAS: 28,
}

/** Rotation order for the per-team backfill, so every club comes round. */
export const TEAM_ROTATION = Object.keys(ESPN_TEAM_IDS)

function normalizeTeam(code) {
  if (!code) return null
  const upper = String(code).toUpperCase()
  return upper === 'WSH' ? 'WAS' : upper
}

/**
 * Name key for matching ESPN's athlete labels against our player rows.
 *
 * Strips accents, punctuation and generational suffixes, because the two feeds
 * disagree constantly: "Ja'Marr Chase" / "JaMarr Chase", "A.J. Brown" / "AJ
 * Brown", "Marvin Harrison Jr." / "Marvin Harrison".
 */
export function nameKey(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'`‘’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchFeed({ team = null, limit = 50 } = {}) {
  const url = new URL(NEWS_URL)
  url.searchParams.set('limit', String(limit))
  if (team) {
    const id = ESPN_TEAM_IDS[normalizeTeam(team)]
    if (!id) throw new Error(`Unknown NFL team ${team}`)
    url.searchParams.set('team', String(id))
  }
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`ESPN news ${res.status} ${res.statusText}`)
  const body = await res.json()
  return Array.isArray(body?.articles) ? body.articles : []
}

/** Pull the fields we store out of ESPN's article shape. */
function normalizeArticle(raw) {
  const categories = Array.isArray(raw.categories) ? raw.categories : []

  const athletes = []
  const seen = new Set()
  for (const c of categories) {
    if (c.type !== 'athlete') continue
    const id = c.athleteId ?? c.athlete?.id
    const name = c.description || c.athlete?.description
    if (!id || !name || seen.has(String(id))) continue
    seen.add(String(id))
    athletes.push({ espnId: String(id), name })
  }

  const teams = [
    ...new Set(
      categories
        .filter((c) => c.type === 'team')
        .map((c) => normalizeTeam(c.team?.abbreviation))
        .filter(Boolean),
    ),
  ]

  // ESPN ships several crops; the first with a url works as a card image.
  const image = (raw.images || []).find((i) => i?.url)?.url || null

  return {
    id: `espn:${raw.id}`,
    source: 'espn',
    headline: raw.headline || raw.title || '',
    description: raw.description || null,
    byline: raw.byline || null,
    type: raw.type || null,
    url: raw.links?.web?.href || raw.links?.mobile?.href || null,
    imageUrl: image,
    publishedAt: raw.published || raw.lastModified || nowIso(),
    teams,
    athletes,
  }
}

/**
 * Resolve ESPN athlete ids to our player ids.
 *
 * Sleeper publishes an `espn_id` but stopped populating it around 2023 — only
 * ~27% of the top 300 carry one, and the gaps are exactly the young stars news
 * is written about. So the match is by name, and the result is cached in
 * `news_player_xref` so each athlete resolves once rather than every refresh.
 *
 * A NULL player_id in that cache is a deliberate negative result: ESPN tags a
 * lot of linemen, defenders and punters we do not carry, and re-checking them
 * on every ingest would be pure waste.
 */
async function resolveAthletes(athletes) {
  const resolved = new Map()
  if (!athletes.length) return resolved

  const ids = [...new Set(athletes.map((a) => a.espnId))]

  // D1 allows at most 100 bound parameters per statement, and a busy news day
  // tags well over that — 50 articles carried 166 distinct athletes in testing.
  const known = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const params = {}
    const keys = slice.map((id, n) => {
      params[`a${n}`] = id
      return `@a${n}`
    })
    const cached = await query(
      `SELECT espn_athlete_id, player_id FROM news_player_xref
        WHERE espn_athlete_id IN (${keys.join(', ')})`,
      params,
    )
    for (const row of cached) known.set(row.espn_athlete_id, row.player_id)
  }
  for (const [espnId, playerId] of known) if (playerId) resolved.set(espnId, playerId)

  const unknown = athletes.filter((a) => !known.has(a.espnId))
  if (!unknown.length) return resolved

  // Only fantasy-relevant positions can match. Team defenses are handled via
  // the article's team tags instead — ESPN never tags a D/ST as an athlete.
  const pool = await query(
    `SELECT id, full_name, position FROM players
      WHERE position IN ('QB','RB','WR','TE','K') AND full_name IS NOT NULL`,
  )
  const index = new Map()
  for (const p of pool) {
    const key = nameKey(p.full_name)
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(p)
  }

  const writes = []
  const at = nowIso()
  for (const athlete of unknown) {
    const matches = index.get(nameKey(athlete.name)) || []
    // Ambiguous names stay unresolved rather than guessing at the wrong player.
    const playerId = matches.length === 1 ? matches[0].id : null
    if (playerId) resolved.set(athlete.espnId, playerId)
    writes.push(
      stmt(
        `INSERT INTO news_player_xref (espn_athlete_id, player_id, display_name, resolved_at)
         VALUES (@espnId, @playerId, @name, @at)
         ON CONFLICT(espn_athlete_id) DO UPDATE SET
           player_id = excluded.player_id,
           display_name = excluded.display_name,
           resolved_at = excluded.resolved_at`,
        { espnId: athlete.espnId, playerId, name: athlete.name, at },
      ),
    )
  }
  if (writes.length) await batch(writes)
  return resolved
}

/**
 * Fetch a feed and merge it into the archive.
 *
 * `team` scopes to one club's feed; omitting it takes the league-wide feed.
 * Returns counts rather than rows — callers are cron jobs and the admin route.
 */
export async function ingestNews({ team = null, limit = 50 } = {}) {
  const raw = await fetchFeed({ team, limit })
  const articles = raw.map(normalizeArticle).filter((a) => a.headline && a.url)
  if (!articles.length) return { fetched: raw.length, stored: 0, tagged: 0, team: team || 'league' }

  const resolved = await resolveAthletes(articles.flatMap((a) => a.athletes))

  const writes = []
  const at = nowIso()
  let tagged = 0
  for (const a of articles) {
    writes.push(
      stmt(
        `INSERT INTO news_articles
           (id, source, headline, description, byline, type, url, image_url, published_at, teams_json, fetched_at)
         VALUES (@id, @source, @headline, @description, @byline, @type, @url, @imageUrl, @publishedAt, @teamsJson, @at)
         ON CONFLICT(id) DO UPDATE SET
           headline = excluded.headline,
           description = excluded.description,
           image_url = excluded.image_url,
           teams_json = excluded.teams_json,
           fetched_at = excluded.fetched_at`,
        {
          id: a.id,
          source: a.source,
          headline: a.headline,
          description: a.description,
          byline: a.byline,
          type: a.type,
          url: a.url,
          imageUrl: a.imageUrl,
          publishedAt: a.publishedAt,
          teamsJson: JSON.stringify(a.teams),
          at,
        },
      ),
    )
    for (const athlete of a.athletes) {
      const playerId = resolved.get(athlete.espnId)
      if (!playerId) continue
      tagged++
      writes.push(
        stmt(
          `INSERT INTO news_article_players (article_id, player_id) VALUES (@articleId, @playerId)
           ON CONFLICT(article_id, player_id) DO NOTHING`,
          { articleId: a.id, playerId },
        ),
      )
    }
  }

  await batch(writes)
  return { fetched: raw.length, stored: articles.length, tagged, team: team || 'league' }
}

/**
 * Forget the unresolved half of the crosswalk so it gets retried.
 *
 * The negative cache is what stops us re-checking linemen forever, but it would
 * also make a miss permanent — and the misses that matter are exactly the ones
 * that fix themselves. Keenan Allen was unmatched on the day ESPN reported he
 * had agreed terms with the Colts, because a free agent isn't in our player
 * dictionary until he is on a roster. Same story for every rookie.
 *
 * So this runs right after the daily player refresh: anything still unmatched
 * is re-resolved against the newer dictionary on the next ingest. It is a few
 * dozen rows, and it is the difference between a new signing showing up in your
 * feed the next day or never.
 */
export async function clearUnresolvedXref() {
  const res = await run('DELETE FROM news_player_xref WHERE player_id IS NULL')
  return { cleared: res.changes }
}

/** Trim the archive. Called from the daily sync so it never grows without end. */
export async function pruneNews({ keepDays = 60 } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
  const res = await run('DELETE FROM news_articles WHERE published_at < @cutoff', { cutoff })
  return { deleted: res.changes }
}

/** Row -> API shape. Tagged players arrive as a delimited group_concat. */
function shapeRow(row) {
  return {
    id: row.id,
    source: row.source,
    headline: row.headline,
    description: row.description,
    byline: row.byline,
    type: row.type,
    url: row.url,
    imageUrl: row.image_url,
    publishedAt: row.published_at,
    teams: JSON.parse(row.teams_json || '[]'),
    players: row.player_names
      ? row.player_names
          .split('')
          .filter(Boolean)
          .map((entry) => {
            const [id, name, position, team] = entry.split('')
            return { id, name, position, team }
          })
      : [],
  }
}

/**
 * Read the feed.
 *
 * `playerIds` narrows to articles tagged with any of them — that one parameter
 * serves the roster filter, the watchlist filter and single-player search,
 * because all three are just different ways of choosing a set of players.
 *
 * `teams` additionally matches articles tagged with those NFL clubs, which is
 * how a rostered D/ST gets news: ESPN tags the Colts, not "Colts D/ST".
 */
export async function listNews({
  playerIds = null,
  teams = null,
  search = null,
  limit = 30,
  before = null,
} = {}) {
  const params = {}
  const where = []

  if (playerIds || teams) {
    const clauses = []
    if (playerIds?.length) {
      // Same 100-parameter ceiling. A roster is 17 and a realistic watchlist is
      // a couple of dozen, so this only ever bites on an absurd watchlist.
      const keys = playerIds.slice(0, CHUNK).map((id, i) => {
        params[`p${i}`] = id
        return `@p${i}`
      })
      clauses.push(
        `EXISTS (SELECT 1 FROM news_article_players nap
                  WHERE nap.article_id = a.id AND nap.player_id IN (${keys.join(', ')}))`,
      )
    }
    if (teams?.length) {
      // teams_json is a short JSON array; a quoted substring test is exact
      // enough here and avoids running json_each over every row.
      const keys = teams.map((t, i) => {
        params[`t${i}`] = `%"${t}"%`
        return `a.teams_json LIKE @t${i}`
      })
      clauses.push(`(${keys.join(' OR ')})`)
    }
    // An empty selection returns nothing rather than the whole league feed, so
    // an empty watchlist reads as empty instead of silently unfiltered.
    where.push(clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0')
  }

  if (search) {
    params.search = `%${search}%`
    where.push('(a.headline LIKE @search OR a.description LIKE @search)')
  }

  if (before) {
    params.before = before
    where.push('a.published_at < @before')
  }

  params.limit = Math.min(Number(limit) || 30, 100)

  const rows = await query(
    `SELECT a.id, a.source, a.headline, a.description, a.byline, a.type, a.url,
            a.image_url, a.published_at, a.teams_json,
            (SELECT group_concat(p.id || char(2) || p.full_name || char(2) ||
                                 COALESCE(p.position,'') || char(2) || COALESCE(p.nfl_team,''), char(1))
               FROM news_article_players nap
               JOIN players p ON p.id = nap.player_id
              WHERE nap.article_id = a.id) AS player_names
       FROM news_articles a
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.published_at DESC
      LIMIT @limit`,
    params,
  )
  return rows.map(shapeRow)
}

/** Feed freshness, for the "updated Nm ago" line. */
export async function newsStatus() {
  const rows = await query(
    'SELECT COUNT(*) AS total, MAX(published_at) AS latest, MAX(fetched_at) AS fetched FROM news_articles',
  )
  return { total: rows[0]?.total ?? 0, latest: rows[0]?.latest ?? null, fetchedAt: rows[0]?.fetched ?? null }
}
