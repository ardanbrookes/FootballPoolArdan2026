/**
 * Playoffs — a four-team bracket over two weeks.
 *
 *   Week 15  Semifinals   1 v 4  and  2 v 3, higher seed hosts
 *   Week 16  Final        the two winners
 *
 * Nothing is stored before it's real. Seeds are derived from the standings on
 * every read, the semifinals are created once the regular season ends, and the
 * final is created only after both semifinals are settled — so a bracket can
 * never sit in the database contradicting the results that produced it.
 *
 * A tied game advances the higher seed: the regular season is the tiebreaker.
 */

import { get, query, batch, stmt } from '../db.js'
import { playoffs as playoffConfig, playoffWeeks } from '../config.js'
import { getStandings } from './scoring.js'

const SEMIS = playoffConfig.rounds[0]
const FINAL = playoffConfig.rounds[1]

const winPct = (team) => {
  const games = team.wins + team.losses + team.ties
  return games ? (team.wins + team.ties * 0.5) / games : 0
}

/** Standings order used for seeding: win pct, then points for. */
export function seedTeams(standings) {
  return [...standings]
    .sort((a, b) => winPct(b) - winPct(a) || b.points_for - a.points_for || a.id - b.id)
    .map((team, index) => ({ ...team, seed: index + 1, winPct: winPct(team) }))
}

/** Who's in, who's chasing, and who can no longer get there. */
function chaseInfo(seeded, regularSeasonWeeks, currentWeek) {
  const spots = playoffConfig.teams
  const cutoff = seeded[spots - 1]
  if (!cutoff) return seeded.map((team) => ({ ...team, status: 'in' }))

  // Games left comes from the calendar, not each team's games-played count:
  // deriving it per team meant any drift between standings and schedule
  // reported the season as finished and eliminated everyone.
  const remaining = Math.max(0, regularSeasonWeeks - (currentWeek - 1))

  return seeded.map((team) => {
    const myFloor = team.wins + team.ties * 0.5

    if (team.seed <= spots) {
      const bestChaser = seeded[spots]
      const chaserCeiling = bestChaser ? bestChaser.wins + bestChaser.ties * 0.5 + remaining : 0
      return {
        ...team,
        remaining,
        status: remaining === 0 || myFloor > chaserCeiling ? 'clinched' : 'in',
      }
    }

    const myCeiling = myFloor + remaining
    const cutoffFloor = cutoff.wins + cutoff.ties * 0.5
    return {
      ...team,
      remaining,
      gamesBack: Math.round((cutoffFloor - myFloor) * 10) / 10,
      status: myCeiling < cutoffFloor ? 'eliminated' : 'hunting',
    }
  })
}

/** Playoff matchups for a week, joined to team names and seeds. */
async function roundMatchups(leagueId, season, week, seedByTeamId) {
  const rows = await query(
    `SELECT m.id, m.week, m.status, m.home_score, m.away_score,
            h.id AS home_id, h.name AS home_name, h.abbreviation AS home_abbr, hu.display_name AS home_manager,
            a.id AS away_id, a.name AS away_name, a.abbreviation AS away_abbr, au.display_name AS away_manager
       FROM matchups m
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
       LEFT JOIN users hu ON hu.id = h.user_id
       LEFT JOIN users au ON au.id = a.user_id
      WHERE m.league_id = @leagueId AND m.season = @season AND m.week = @week
      ORDER BY m.id ASC`,
    { leagueId, season, week },
  )

  return rows.map((row) => {
    const homeSeed = seedByTeamId.get(row.home_id) ?? null
    const awaySeed = seedByTeamId.get(row.away_id) ?? null

    let winnerTeamId = null
    if (row.status === 'final') {
      if (row.home_score > row.away_score) winnerTeamId = row.home_id
      else if (row.away_score > row.home_score) winnerTeamId = row.away_id
      // Dead heat: the better regular season advances.
      else winnerTeamId = (homeSeed ?? 99) <= (awaySeed ?? 99) ? row.home_id : row.away_id
    }

    return {
      id: row.id,
      week: row.week,
      status: row.status,
      winnerTeamId,
      home: {
        teamId: row.home_id,
        name: row.home_name,
        abbreviation: row.home_abbr,
        manager: row.home_manager,
        seed: homeSeed,
        score: row.home_score,
      },
      away: {
        teamId: row.away_id,
        name: row.away_name,
        abbreviation: row.away_abbr,
        manager: row.away_manager,
        seed: awaySeed,
        score: row.away_score,
      },
    }
  })
}

/**
 * The playoff picture.
 *
 * During the regular season this is the race for the four spots. From week 15 it
 * becomes the bracket: semifinals, then the final once the semis resolve.
 */
export async function getPlayoffPicture(leagueId) {
  const league = await get('SELECT id, season, current_week FROM leagues WHERE id = @leagueId', { leagueId })
  if (!league) return null

  const regularSeasonWeeks = playoffConfig.regularSeasonWeeks
  const standings = await getStandings(leagueId)
  const seeded = seedTeams(standings)
  const withStatus = chaseInfo(seeded, regularSeasonWeeks, league.current_week)
  const seedByTeamId = new Map(seeded.map((t) => [t.id, t.seed]))

  const inPlayoffs = league.current_week > regularSeasonWeeks

  let bracket = null
  if (inPlayoffs) {
    const [semifinals, finals] = await Promise.all([
      roundMatchups(leagueId, league.season, SEMIS.week, seedByTeamId),
      roundMatchups(leagueId, league.season, FINAL.week, seedByTeamId),
    ])

    const final = finals[0] ?? null
    const champion = final?.winnerTeamId
      ? [final.home, final.away].find((side) => side.teamId === final.winnerTeamId)
      : null

    bracket = {
      rounds: [
        { week: SEMIS.week, name: SEMIS.name, matchups: semifinals },
        { week: FINAL.week, name: FINAL.name, matchups: final ? [final] : [] },
      ],
      semifinalsComplete: semifinals.length > 0 && semifinals.every((m) => m.status === 'final'),
      champion,
    }
  }

  return {
    currentWeek: league.current_week,
    regularSeasonWeeks,
    playoffWeeks,
    spots: playoffConfig.teams,
    inPlayoffs,
    weeksRemaining: Math.max(0, regularSeasonWeeks - (league.current_week - 1)),
    seeds: withStatus,
    bracket,
  }
}

/**
 * Create whichever playoff round is now due.
 *
 * Called from the weekly reset, so it runs twice: once entering week 15 to build
 * the semifinals from the seeds, and again entering week 16 to build the final
 * from the semifinal winners. Idempotent — an existing round is left alone, so a
 * re-run can't duplicate a game or re-seed a bracket already under way.
 */
export async function ensurePlayoffMatchups(leagueId) {
  const league = await get('SELECT id, season, current_week FROM leagues WHERE id = @leagueId', { leagueId })
  if (!league) return { created: 0 }
  if (league.current_week <= playoffConfig.regularSeasonWeeks) return { created: 0 }

  const seeded = seedTeams(await getStandings(leagueId))
  const seedByTeamId = new Map(seeded.map((t) => [t.id, t.seed]))
  const bySeed = new Map(seeded.map((t) => [t.seed, t]))

  const writes = []
  const detail = []

  // --- Semifinals ---
  const existingSemis = await roundMatchups(leagueId, league.season, SEMIS.week, seedByTeamId)
  if (existingSemis.length === 0 && seeded.length >= playoffConfig.teams) {
    for (const [highSeed, lowSeed] of SEMIS.pairings) {
      const home = bySeed.get(highSeed)
      const away = bySeed.get(lowSeed)
      if (!home || !away) continue

      writes.push(
        stmt(
          `INSERT INTO matchups (league_id, season, week, home_team_id, away_team_id, status)
           VALUES (@leagueId, @season, @week, @homeId, @awayId, 'scheduled')`,
          { leagueId, season: league.season, week: SEMIS.week, homeId: home.id, awayId: away.id },
        ),
      )
      detail.push(`SF: #${highSeed} ${home.abbreviation} v #${lowSeed} ${away.abbreviation}`)
    }
  }

  // --- Final --- only once both semifinals have been settled.
  if (league.current_week >= FINAL.week) {
    const existingFinal = await roundMatchups(leagueId, league.season, FINAL.week, seedByTeamId)
    const semis = existingSemis.length ? existingSemis : []

    if (existingFinal.length === 0 && semis.length === 2 && semis.every((m) => m.winnerTeamId)) {
      const winners = semis
        .map((m) => [m.home, m.away].find((side) => side.teamId === m.winnerTeamId))
        .filter(Boolean)
        .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99))

      if (winners.length === 2) {
        writes.push(
          stmt(
            `INSERT INTO matchups (league_id, season, week, home_team_id, away_team_id, status)
             VALUES (@leagueId, @season, @week, @homeId, @awayId, 'scheduled')`,
            {
              leagueId,
              season: league.season,
              week: FINAL.week,
              // Better seed hosts the final.
              homeId: winners[0].teamId,
              awayId: winners[1].teamId,
            },
          ),
        )
        detail.push(`F: #${winners[0].seed} ${winners[0].abbreviation} v #${winners[1].seed} ${winners[1].abbreviation}`)
      }
    }
  }

  if (writes.length) await batch(writes)
  return { created: writes.length, detail }
}
