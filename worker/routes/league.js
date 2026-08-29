import { Hono } from 'hono'
import { DateTime } from 'luxon'
import { get, query } from '../db.js'
import { loadLeague, requireCommissioner, requireUser } from '../middleware/auth.js'
import { getLockState, isPlayerLocked, playerLockReason } from '../services/locks.js'
import { getStandings, getLineupWithPoints } from '../services/scoring.js'
import { getPublicConfig, setSetting, getTiming } from '../services/settings.js'
import { getWeekGames, getTeamGameStatus } from '../services/schedule.js'
import { getWaiverOrder } from '../services/waivers.js'
import { getPlayoffPicture } from '../services/playoffs.js'
import { winProbability } from '../services/winprob.js'

const router = new Hono()
router.use('*', loadLeague)

/** Everything the home screen needs in one round trip. */
router.get('/', async (c) => {
  const league = c.get('league')
  const user = c.get('user')

  const [config, lockState, standings, myTeam] = await Promise.all([
    getPublicConfig(league.id),
    getLockState(league.id),
    getStandings(league.id),
    user
      ? get('SELECT * FROM teams WHERE league_id = @leagueId AND user_id = @userId', {
          leagueId: league.id,
          userId: user.id,
        })
      : Promise.resolve(null),
  ])

  return c.json({
    league: {
      id: league.id,
      name: league.name,
      season: league.season,
      seasonType: league.season_type,
      currentWeek: league.current_week,
      playoffWeek: league.playoff_week,
      rulesUrl: league.rules_url,
      draftUrl: league.draft_url,
    },
    config,
    lockState,
    standings,
    myTeam: myTeam ? { id: myTeam.id, name: myTeam.name, abbreviation: myTeam.abbreviation } : null,
  })
})

/**
 * Current lock state. `?at=<ISO>` evaluates the rules at a different instant —
 * handy for answering "what will be locked on Thursday night?" without waiting
 * for Thursday night.
 */
router.get('/lock-state', async (c) => {
  const at = c.req.query('at')
  if (!at) return c.json(await getLockState(c.get('league').id))

  const ref = DateTime.fromISO(at, { zone: (await getTiming(c.get('league').id)).timezone })
  if (!ref.isValid) return c.json({ error: `Invalid "at" timestamp: ${ref.invalidReason}` }, 400)
  return c.json(await getLockState(c.get('league').id, ref))
})

router.get('/standings', async (c) => c.json({ standings: await getStandings(c.get('league').id) }))

router.get('/waiver-order', async (c) => c.json({ order: await getWaiverOrder(c.get('league').id) }))

/** Fantasy matchups for a week, with live scores. */
router.get('/matchups', async (c) => {
  const league = c.get('league')
  const week = Number(c.req.query('week') ?? league.current_week)
  const matchups = await query(
    `SELECT m.id, m.week, m.home_score, m.away_score, m.status,
            h.id AS home_id, h.name AS home_name, h.abbreviation AS home_abbr,
            h.wins AS home_wins, h.losses AS home_losses, h.ties AS home_ties,
            a.id AS away_id, a.name AS away_name, a.abbreviation AS away_abbr,
            a.wins AS away_wins, a.losses AS away_losses, a.ties AS away_ties
       FROM matchups m
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
      WHERE m.league_id = @leagueId AND m.season = @season AND m.week = @week
      ORDER BY m.id ASC`,
    { leagueId: league.id, season: league.season, week },
  )
  return c.json({ week, matchups })
})

/**
 * One head-to-head matchup, player by player, with live scores.
 *
 * This is the Sunday-afternoon view: both starting lineups side by side, each
 * player's score so far, and where their NFL game stands. Defaults to the
 * signed-in manager's matchup; `?teamId=` picks someone else's.
 */
router.get('/matchup', requireUser, async (c) => {
  const league = c.get('league')
  const user = c.get('user')
  const week = Number(c.req.query('week') ?? league.current_week)

  const requestedTeamId = c.req.query('teamId')
  const team = requestedTeamId
    ? await get('SELECT * FROM teams WHERE id = @teamId AND league_id = @leagueId', {
        teamId: Number(requestedTeamId),
        leagueId: league.id,
      })
    : await get('SELECT * FROM teams WHERE user_id = @userId AND league_id = @leagueId', {
        userId: user.id,
        leagueId: league.id,
      })

  if (!team) return c.json({ week, matchup: null })

  const matchup = await get(
    `SELECT * FROM matchups
      WHERE league_id = @leagueId AND season = @season AND week = @week
        AND (home_team_id = @teamId OR away_team_id = @teamId)`,
    { leagueId: league.id, season: league.season, week, teamId: team.id },
  )
  if (!matchup) return c.json({ week, matchup: null })

  // The NFL week the fantasy week is actually playing — the lock engine already
  // derives this from the schedule, so reuse it rather than assuming they match.
  const lockState = await getLockState(league.id)
  const nflWeek = lockState.activeWeek ?? week
  const gameStatus = await getTeamGameStatus(league.season, nflWeek, league.season_type)

  const side = async (teamId) => {
    const [meta, slots] = await Promise.all([
      get('SELECT id, name, abbreviation, wins, losses, ties FROM teams WHERE id = @teamId', { teamId }),
      getLineupWithPoints(league.id, teamId, league.season, week),
    ])

    const starters = slots.map((slot) => {
      if (!slot.player) return slot
      const game = gameStatus.get(slot.player.nflTeam) || null
      return {
        ...slot,
        player: {
          ...slot.player,
          game: game && {
            status: game.status,
            kickoffAt: game.kickoffAt,
            // "@BUF" reads faster than a home/away flag on a scoreboard.
            versus: `${game.isHome ? 'vs' : '@'}${game.opponent}`,
          },
          // No game this week means a bye — worth flagging, since a bye player
          // silently scoring zero is a common way to lose a week.
          onBye: !game,
        },
      }
    })

    const played = starters.filter((s) => s.player?.game?.status === 'final').length
    const live = starters.filter((s) => s.player?.game?.status === 'in_progress').length

    return {
      team: meta,
      starters,
      total: Math.round(starters.reduce((sum, s) => sum + (s.player?.points ?? 0), 0) * 100) / 100,
      projectedTotal:
        Math.round(starters.reduce((sum, s) => sum + (s.player?.projectedPoints ?? 0), 0) * 100) / 100,
      yetToPlay: starters.filter((s) => s.player && s.player.game?.status === 'scheduled').length,
      inProgress: live,
      final: played,
    }
  }

  const [home, away] = await Promise.all([side(matchup.home_team_id), side(matchup.away_team_id)])

  return c.json({
    week,
    nflWeek,
    myTeamId: team.id,
    matchup: {
      id: matchup.id,
      status: matchup.status,
      home,
      away,
      winProbability: winProbability(home.starters, away.starters),
    },
  })
})

/**
 * Everything the League page needs, in one request.
 *
 * The page merged Standings / Rosters / Schedule / Results into a single view,
 * so four round trips became one. Schedule and results are the same rows —
 * a matchup is a "result" once it's final — so they're returned together.
 */
router.get('/overview', requireUser, async (c) => {
  const league = c.get('league')
  const week = Number(c.req.query('week') ?? league.current_week)

  const [playoffPicture, standings, scheduleRows] = await Promise.all([
    getPlayoffPicture(league.id),
    getStandings(league.id),
    query(
      `SELECT m.week, m.status, m.home_score, m.away_score,
              h.id AS home_id, h.name AS home_name, h.abbreviation AS home_abbr,
              a.id AS away_id, a.name AS away_name, a.abbreviation AS away_abbr
         FROM matchups m
         JOIN teams h ON h.id = m.home_team_id
         JOIN teams a ON a.id = m.away_team_id
        WHERE m.league_id = @leagueId AND m.season = @season
        ORDER BY m.week ASC, m.id ASC`,
      { leagueId: league.id, season: league.season },
    ),
  ])

  const byWeek = new Map()
  for (const row of scheduleRows) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, [])
    byWeek.get(row.week).push(row)
  }

  const weeks = [...byWeek.entries()].map(([weekNumber, matchups]) => ({
    week: weekNumber,
    isPlayoff: weekNumber > (playoffPicture?.regularSeasonWeeks ?? 14),
    complete: matchups.every((m) => m.status === 'final'),
    matchups,
  }))

  return c.json({
    week,
    currentWeek: league.current_week,
    standings,
    playoffs: playoffPicture,
    weeks,
  })
})

/** Playoff picture on its own, for lighter polling. */
router.get('/playoffs', requireUser, async (c) => {
  return c.json({ playoffs: await getPlayoffPicture(c.get('league').id) })
})

/** Full league schedule, grouped by week. */
router.get('/schedule', async (c) => {
  const league = c.get('league')
  const rows = await query(
    `SELECT m.week, m.status, m.home_score, m.away_score,
            h.name AS home_name, h.abbreviation AS home_abbr,
            a.name AS away_name, a.abbreviation AS away_abbr
       FROM matchups m
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
      WHERE m.league_id = @leagueId AND m.season = @season
      ORDER BY m.week ASC, m.id ASC`,
    { leagueId: league.id, season: league.season },
  )

  const byWeek = new Map()
  for (const row of rows) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, [])
    byWeek.get(row.week).push(row)
  }
  return c.json({ weeks: [...byWeek.entries()].map(([week, matchups]) => ({ week, matchups })) })
})

/** NFL games for a week — used to show kickoff times and which teams lock when. */
router.get('/nfl-games', async (c) => {
  const league = c.get('league')
  const week = Number(c.req.query('week') ?? league.current_week)
  return c.json({ week, games: await getWeekGames(league.season, week, league.season_type) })
})

/** Every team's roster — the "League > Rosters" view. */
router.get('/rosters', async (c) => {
  const league = c.get('league')
  const week = Number(c.req.query('week') ?? league.current_week)
  const teams = await query(
    `SELECT t.id, t.name, t.abbreviation, u.display_name AS manager
       FROM teams t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.league_id = @leagueId ORDER BY t.name ASC`,
    { leagueId: league.id },
  )

  // Lock state travels with every player here, not just on your own roster:
  // the trade builder needs to know an opponent's Thursday-night player can't
  // move *before* the offer is built, rather than failing on submit.
  const lockState = await getLockState(league.id)
  const decorate = (player) =>
    player && {
      ...player,
      locked: isPlayerLocked(lockState, { nfl_team: player.nflTeam }),
      lockReason: playerLockReason(lockState, { nfl_team: player.nflTeam }),
    }

  const withRosters = await Promise.all(
    teams.map(async (team) => {
      const starters = await getLineupWithPoints(league.id, team.id, league.season, week)
      const startingIds = new Set(starters.map((s) => s.player?.id).filter(Boolean))
      const roster = await query(
        `SELECT p.id, p.full_name AS name, p.position, p.nfl_team AS nflTeam, p.injury_status AS injuryStatus
           FROM roster_players rp JOIN players p ON p.id = rp.player_id
          WHERE rp.league_id = @leagueId AND rp.team_id = @teamId`,
        { leagueId: league.id, teamId: team.id },
      )
      return {
        ...team,
        starters: starters.map((slot) => ({ ...slot, player: decorate(slot.player) })),
        bench: roster.filter((p) => !startingIds.has(p.id)).map(decorate),
      }
    }),
  )

  return c.json({ week, lockState, teams: withRosters })
})

/** Recent adds, drops and trades across the league. */
router.get('/transactions', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 40), 200)
  return c.json({
    transactions: await query(
      `SELECT tx.id, tx.type, tx.source, tx.season, tx.week, tx.notes, tx.created_at,
              t.name AS team_name, t.abbreviation AS team_abbr,
              p.full_name AS player_name, p.position, p.nfl_team,
              rp.full_name AS related_player_name
         FROM transactions tx
         LEFT JOIN teams t ON t.id = tx.team_id
         LEFT JOIN players p ON p.id = tx.player_id
         LEFT JOIN players rp ON rp.id = tx.related_player_id
        WHERE tx.league_id = @leagueId
        ORDER BY tx.created_at DESC, tx.id DESC
        LIMIT @limit`,
      { leagueId: c.get('league').id, limit },
    ),
  })
})

/** Commissioner: adjust deadlines without a redeploy. */
router.put('/settings', requireUser, requireCommissioner, async (c) => {
  const league = c.get('league')
  const { key, value } = c.get('body') || {}
  const allowed = ['timing.timezone', 'timing.waiverProcess', 'timing.weekReset', 'timing.blanketLock', 'waivers']
  if (!allowed.includes(key)) {
    return c.json({ error: `Unsupported setting "${key}".`, allowed }, 400)
  }
  await setSetting(league.id, key, value)
  return c.json({ config: await getPublicConfig(league.id), lockState: await getLockState(league.id) })
})

export default router
