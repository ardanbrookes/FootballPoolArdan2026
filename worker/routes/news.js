import { Hono } from 'hono'
import { query, get } from '../db.js'
import { loadLeague, requireUser } from '../middleware/auth.js'
import { listNews, newsStatus } from '../services/news.js'

const router = new Hono()
router.use('*', loadLeague)

/**
 * The four scopes the news tab offers. Each one resolves to a set of players
 * (and, for a rostered D/ST, a set of NFL clubs) and then runs the same query —
 * "articles tagged with any of these" is the only filter the feed really has.
 */
async function resolveScope({ scope, leagueId, userId, teamId, playerId }) {
  switch (scope) {
    case 'team': {
      if (!teamId) return { playerIds: [], teams: [] }
      const rows = await query(
        `SELECT p.id, p.position, p.nfl_team
           FROM roster_players rp
           JOIN players p ON p.id = rp.player_id
          WHERE rp.league_id = @leagueId AND rp.team_id = @teamId`,
        { leagueId, teamId },
      )
      return {
        playerIds: rows.filter((r) => r.position !== 'DEF').map((r) => r.id),
        // A team defense is never tagged as an athlete, so it matches on the
        // club instead — that is how the Colts D/ST owner sees Colts news.
        teams: rows.filter((r) => r.position === 'DEF').map((r) => r.nfl_team || r.id),
      }
    }
    case 'watchlist': {
      const rows = await query(
        `SELECT p.id, p.position, p.nfl_team
           FROM watchlist w
           JOIN players p ON p.id = w.player_id
          WHERE w.league_id = @leagueId AND w.user_id = @userId`,
        { leagueId, userId },
      )
      return {
        playerIds: rows.filter((r) => r.position !== 'DEF').map((r) => r.id),
        teams: rows.filter((r) => r.position === 'DEF').map((r) => r.nfl_team || r.id),
      }
    }
    case 'player': {
      if (!playerId) return { playerIds: [], teams: [] }
      const row = await get('SELECT id, position, nfl_team FROM players WHERE id = @playerId', { playerId })
      if (!row) return { playerIds: [], teams: [] }
      return row.position === 'DEF'
        ? { playerIds: [], teams: [row.nfl_team || row.id] }
        : { playerIds: [row.id], teams: [] }
    }
    default:
      // League-wide: no player filter at all.
      return null
  }
}

/**
 * GET /news
 *   ?scope=league|team|watchlist|player
 *   ?playerId=<id>   (scope=player)
 *   ?q=<text>        free-text search across headline and summary
 *   ?before=<iso>    pages backwards
 */
router.get('/', requireUser, async (c) => {
  const league = c.get('league')
  const user = c.get('user')
  const scope = c.req.query('scope') || 'league'

  const team = await get(
    'SELECT id FROM teams WHERE league_id = @leagueId AND user_id = @userId',
    { leagueId: league.id, userId: user.id },
  )

  const selection = await resolveScope({
    scope,
    leagueId: league.id,
    userId: user.id,
    teamId: team?.id ?? null,
    playerId: c.req.query('playerId') || null,
  })

  const articles = await listNews({
    playerIds: selection?.playerIds ?? null,
    teams: selection?.teams ?? null,
    search: c.req.query('q') || null,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    before: c.req.query('before') || null,
  })

  return c.json({ scope, articles, status: await newsStatus() })
})

export default router
