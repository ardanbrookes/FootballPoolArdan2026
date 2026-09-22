/**
 * The Monday-night recap: what actually happened in the week that just ended.
 *
 * Built once, at the week reset, and stored. That timing is deliberate — half
 * of it is measured against the rosters as they were that week (the lineup you
 * could have set, the points left on your bench), and rosters reopen the
 * instant the reset finishes. A recap computed on Thursday would score
 * somebody's optimal lineup against players they picked up afterwards.
 *
 * Every number here is descriptive except the playoff odds, which are a
 * simulation and say so.
 */

import { get, query, run } from '../db.js'
import {
  rosterSlots,
  playoffs as playoffConfig,
  positionVariance,
  defaultPositionSd,
} from '../config.js'
import { canPlayerFillSlot } from './roster.js'
import { getWeekPoints, getWeekProjections, getRestOfSeasonPoints } from './scoring.js'

/**
 * Enough runs that the same week doesn't swing by five points between
 * rebuilds. At 2000 the noise was visible; the whole simulation is still a
 * few hundred thousand draws, once a week.
 */
const SIMULATIONS = 5000

const round1 = (n) => Math.round(n * 10) / 10

/** Box–Muller. Good enough for a league of eight. */
function gaussian(mean, sd) {
  const u = Math.random() || Number.EPSILON
  const v = Math.random()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function bestFree(candidates, used, valueOf) {
  let best = null
  for (const player of candidates) {
    if (used.has(player.id)) continue
    if (!best || valueOf(player) > valueOf(best)) best = player
  }
  return best
}

/**
 * The best lineup a roster could have produced, by whatever measure `valueOf`
 * returns — points for hindsight, rest-of-season projection for forecasting.
 *
 * Fills the most restrictive slots first, so the FLEX can't take the only
 * player eligible for a thinner slot, then keeps swapping in improvements
 * until a pass changes nothing. Exchanging two players already in the lineup
 * never changes the total, so only promotions off the bench can gain.
 */
export function optimalLineup(players, valueOf) {
  const slots = rosterSlots.map((slot) => ({
    slot: slot.slot,
    label: slot.label,
    candidates: players.filter((player) => canPlayerFillSlot(player, slot.slot)),
  }))

  const picked = new Map()
  const used = new Set()

  for (const slot of [...slots].sort((a, b) => a.candidates.length - b.candidates.length)) {
    const best = bestFree(slot.candidates, used, valueOf)
    if (best) {
      picked.set(slot.slot, best)
      used.add(best.id)
    }
  }

  for (let pass = 0; pass < slots.length; pass += 1) {
    let improved = false
    for (const slot of slots) {
      const current = picked.get(slot.slot) ?? null
      const best = bestFree(slot.candidates, used, valueOf)
      if (best && valueOf(best) > (current ? valueOf(current) : 0)) {
        if (current) used.delete(current.id)
        picked.set(slot.slot, best)
        used.add(best.id)
        improved = true
      }
    }
    if (!improved) break
  }

  const picks = slots.map((slot) => ({
    slot: slot.slot,
    label: slot.label,
    player: picked.get(slot.slot) ?? null,
  }))

  return {
    total: round1(picks.reduce((sum, p) => sum + (p.player ? valueOf(p.player) : 0), 0)),
    picks,
  }
}

/** Win pct, then points for — the league's own seeding order. */
function rank(rows) {
  return [...rows].sort((a, b) => {
    const played = (t) => t.wins + t.losses + t.ties
    const pct = (t) => (played(t) ? (t.wins + t.ties * 0.5) / played(t) : 0)
    return pct(b) - pct(a) || b.pointsFor - a.pointsFor
  })
}

/**
 * How often each team makes the bracket, simulating the rest of the season.
 *
 * A team's week is drawn from a normal distribution: the mean is the lineup
 * their roster projects to score, spread over the weeks left, and the spread
 * comes from how erratic those positions are. It ignores injuries, waivers and
 * trades, so it is a snapshot of today's rosters playing out the schedule —
 * which is the honest version of "odds based on record and projections".
 */
async function playoffOdds(leagueId, season, week, teams, roster) {
  const weeksLeft = playoffConfig.regularSeasonWeeks - week
  const base = teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    abbreviation: t.abbreviation,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    pointsFor: t.points_for,
  }))

  // Nothing left to play: the table is the answer, not a probability.
  if (weeksLeft <= 0) {
    const ranked = rank(base)
    return ranked.map((team, index) => ({
      ...team,
      odds: index < playoffConfig.teams ? 100 : 0,
      settled: true,
    }))
  }

  const remaining = await query(
    `SELECT week, home_team_id, away_team_id FROM matchups
      WHERE league_id = @leagueId AND season = @season AND week > @week AND week <= @lastWeek`,
    { leagueId, season, week, lastWeek: playoffConfig.regularSeasonWeeks },
  )

  const ros = await getRestOfSeasonPoints(
    season,
    week + 1,
    playoffConfig.regularSeasonWeeks,
    'regular',
    undefined,
    { playerIds: roster.map((p) => p.id) },
  )

  const strength = new Map()
  for (const team of teams) {
    const squad = roster.filter((p) => p.team_id === team.id)
    const best = optimalLineup(squad, (p) => ros.get(p.id) ?? 0)
    const variance = best.picks.reduce((sum, pick) => {
      if (!pick.player) return sum
      const sd = positionVariance[pick.player.position] ?? defaultPositionSd
      return sum + sd * sd
    }, 0)
    strength.set(team.id, {
      mean: best.total / weeksLeft,
      sd: Math.sqrt(variance) || 20,
    })
  }

  const made = new Map(teams.map((t) => [t.id, 0]))

  for (let sim = 0; sim < SIMULATIONS; sim += 1) {
    const table = new Map(base.map((t) => [t.teamId, { ...t }]))

    for (const game of remaining) {
      const home = table.get(game.home_team_id)
      const away = table.get(game.away_team_id)
      if (!home || !away) continue

      const homeStrength = strength.get(game.home_team_id)
      const awayStrength = strength.get(game.away_team_id)
      const homeScore = gaussian(homeStrength.mean, homeStrength.sd)
      const awayScore = gaussian(awayStrength.mean, awayStrength.sd)

      home.pointsFor += homeScore
      away.pointsFor += awayScore
      if (homeScore > awayScore) {
        home.wins += 1
        away.losses += 1
      } else if (awayScore > homeScore) {
        away.wins += 1
        home.losses += 1
      } else {
        home.ties += 1
        away.ties += 1
      }
    }

    for (const team of rank([...table.values()]).slice(0, playoffConfig.teams)) {
      made.set(team.teamId, made.get(team.teamId) + 1)
    }
  }

  return rank(base)
    .map((team) => ({
      ...team,
      odds: Math.round((made.get(team.teamId) / SIMULATIONS) * 1000) / 10,
      settled: false,
    }))
    .sort((a, b) => b.odds - a.odds)
}

/** Highest (or lowest) by a key, ignoring rows where it is missing. */
function pick(rows, key, direction = 'desc') {
  const usable = rows.filter((row) => row[key] != null)
  if (!usable.length) return null
  return [...usable].sort((a, b) => (direction === 'desc' ? b[key] - a[key] : a[key] - b[key]))[0]
}

export async function buildWeekRecap(leagueId, season, week, { store = true } = {}) {
  const teams = await query(
    `SELECT id, name, abbreviation, wins, losses, ties, points_for
       FROM teams WHERE league_id = @leagueId ORDER BY name`,
    { leagueId },
  )
  if (!teams.length) return null

  const [matchups, previousMatchups, lineupRows, rosterRows] = await Promise.all([
    query(
      `SELECT id, home_team_id, away_team_id, home_score, away_score FROM matchups
        WHERE league_id = @leagueId AND season = @season AND week = @week`,
      { leagueId, season, week },
    ),
    week > 1
      ? query(
          `SELECT home_team_id, away_team_id, home_score, away_score FROM matchups
            WHERE league_id = @leagueId AND season = @season AND week = @week`,
          { leagueId, season, week: week - 1 },
        )
      : Promise.resolve([]),
    query(
      `SELECT l.team_id, l.slot, l.player_id, p.full_name, p.position, p.nfl_team
         FROM lineups l JOIN players p ON p.id = l.player_id
        WHERE l.league_id = @leagueId AND l.season = @season AND l.week = @week
          AND l.player_id IS NOT NULL`,
      { leagueId, season, week },
    ),
    // IR players can't be started, so they can't be part of a lineup anyone
    // could have set.
    query(
      `SELECT rp.team_id, p.id, p.full_name, p.position, p.fantasy_positions, p.nfl_team
         FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.on_ir = 0`,
      { leagueId },
    ),
  ])

  if (!matchups.length) return null

  const started = lineupRows.map((row) => ({
    teamId: row.team_id,
    slot: row.slot,
    id: row.player_id,
    name: row.full_name,
    position: row.position,
    nflTeam: row.nfl_team,
  }))

  const playerIds = [...new Set([...started.map((p) => p.id), ...rosterRows.map((p) => p.id)])]
  const scope = { playerIds }
  const [points, projections] = await Promise.all([
    getWeekPoints(season, week, 'regular', undefined, scope),
    getWeekProjections(season, week, 'regular', undefined, scope),
  ])

  const scoreOf = (teamId, rows) => {
    const map = new Map()
    for (const m of rows) {
      map.set(m.home_team_id, m.home_score)
      map.set(m.away_team_id, m.away_score)
    }
    return map.get(teamId) ?? null
  }

  const teamLines = teams.map((team) => {
    const squad = rosterRows.filter((p) => p.team_id === team.id)
    const lineup = started.filter((p) => p.teamId === team.id)
    const best = optimalLineup(squad, (p) => points.get(p.id) ?? 0)

    const actual = scoreOf(team.id, matchups) ?? 0
    const projected = lineup.reduce((sum, p) => sum + (projections.get(p.id) ?? 0), 0)
    const previous = week > 1 ? scoreOf(team.id, previousMatchups) : null

    return {
      teamId: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      points: round1(actual),
      projected: round1(projected),
      optimal: best.total,
      // Never negative: the optimal lineup is drawn from the same roster, so
      // it can only match or beat what they actually started.
      leftOnBench: round1(Math.max(0, best.total - actual)),
      vsProjection: round1(actual - projected),
      previousPoints: previous == null ? null : round1(previous),
      change: previous == null ? null : round1(actual - previous),
    }
  })

  const games = matchups.map((m) => {
    const home = teamLines.find((t) => t.teamId === m.home_team_id)
    const away = teamLines.find((t) => t.teamId === m.away_team_id)
    const homeWon = m.home_score >= m.away_score
    return {
      margin: round1(Math.abs(m.home_score - m.away_score)),
      tie: m.home_score === m.away_score,
      winner: homeWon ? home?.name : away?.name,
      loser: homeWon ? away?.name : home?.name,
      winnerPoints: round1(homeWon ? m.home_score : m.away_score),
      loserPoints: round1(homeWon ? m.away_score : m.home_score),
    }
  })

  const startedWithNumbers = started.map((p) => {
    const scored = points.get(p.id) ?? 0
    const projectedPoints = projections.get(p.id) ?? 0
    return {
      ...p,
      team: teams.find((t) => t.id === p.teamId)?.name ?? null,
      points: round1(scored),
      projected: round1(projectedPoints),
      diff: round1(scored - projectedPoints),
    }
  })

  const sections = {
    managers: {
      best: pick(teamLines, 'leftOnBench', 'asc'),
      worst: pick(teamLines, 'leftOnBench', 'desc'),
    },
    blowouts: {
      biggest: pick(games, 'margin', 'desc'),
      closest: pick(games, 'margin', 'asc'),
    },
    scoring: {
      highest: pick(teamLines, 'points', 'desc'),
      lowest: pick(teamLines, 'points', 'asc'),
    },
    projection: {
      over: pick(teamLines, 'vsProjection', 'desc'),
      under: pick(teamLines, 'vsProjection', 'asc'),
    },
    momentum: {
      bounceBack: pick(teamLines, 'change', 'desc'),
      falloff: pick(teamLines, 'change', 'asc'),
    },
    players: {
      overachiever: pick(startedWithNumbers, 'diff', 'desc'),
      // A player projected for nothing who scores nothing isn't a bust, so the
      // floor keeps the answer to players actually expected to do something.
      bust: pick(
        startedWithNumbers.filter((p) => p.projected >= 5),
        'diff',
        'asc',
      ),
    },
  }

  const recap = {
    season,
    week,
    generatedAt: new Date().toISOString(),
    teams: teamLines,
    games,
    sections,
    playoffOdds: await playoffOdds(leagueId, season, week, teams, rosterRows),
  }

  if (store) {
    await run(
      `INSERT INTO week_recaps (league_id, season, week, payload_json, created_at)
       VALUES (@leagueId, @season, @week, @payload, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (league_id, season, week)
       DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
      { leagueId, season, week, payload: JSON.stringify(recap) },
    )
  }

  return recap
}

export async function getWeekRecap(leagueId, season, week) {
  const row = await get(
    `SELECT payload_json FROM week_recaps
      WHERE league_id = @leagueId AND season = @season AND week = @week`,
    { leagueId, season, week },
  )
  if (!row) return null
  try {
    return JSON.parse(row.payload_json)
  } catch {
    return null
  }
}

/**
 * The feed version: the lines worth reading on a phone, one per row.
 *
 * Deliberately shorter than the card on the home page — chat is for the
 * headlines and the bragging rights, not the full table.
 */
export function recapChatBody(recap) {
  const { sections } = recap
  const lines = [`Week ${recap.week} recap`]
  const signed = (n) => (n > 0 ? `+${n}` : String(n))

  if (sections.scoring.highest) {
    lines.push(
      `High score: ${sections.scoring.highest.name} ${sections.scoring.highest.points} · ` +
        `Low: ${sections.scoring.lowest.name} ${sections.scoring.lowest.points}`,
    )
  }
  if (sections.blowouts.biggest) {
    const closest = sections.blowouts.closest
    lines.push(
      `Biggest win: ${sections.blowouts.biggest.winner} by ${sections.blowouts.biggest.margin} · ` +
        (closest.tie
          ? `Closest: ${closest.winner} and ${closest.loser} tied`
          : `Closest: ${closest.winner} by ${closest.margin}`),
    )
  }
  if (sections.managers.worst) {
    lines.push(
      `Best manager: ${sections.managers.best.name} left ${sections.managers.best.leftOnBench} on the bench · ` +
        `Worst: ${sections.managers.worst.name} left ${sections.managers.worst.leftOnBench}`,
    )
  }
  if (sections.projection.over) {
    // Projections run hot: a whole league can miss them, and then the best
    // team of the week is still a negative number.
    const over = sections.projection.over
    const label = over.vsProjection >= 0 ? 'Over projection' : 'Closest to projection'
    lines.push(
      `${label}: ${over.name} ${signed(over.vsProjection)} · ` +
        `Under: ${sections.projection.under.name} ${signed(sections.projection.under.vsProjection)}`,
    )
  }
  if (sections.momentum.bounceBack?.change != null) {
    const up = sections.momentum.bounceBack
    const down = sections.momentum.falloff
    lines.push(
      `${up.change >= 0 ? 'Bounce back' : 'Smallest drop'}: ${up.name} ${signed(up.change)} on last week · ` +
        `${down.change <= 0 ? 'Fall off' : 'Smallest gain'}: ${down.name} ${signed(down.change)}`,
    )
  }
  if (sections.players.overachiever) {
    const star = sections.players.overachiever
    lines.push(`Overachiever: ${star.name} ${star.points} (${signed(star.diff)} vs projection)`)
  }
  if (sections.players.bust) {
    const bust = sections.players.bust
    lines.push(`Bust: ${bust.name} ${bust.points} (${signed(bust.diff)} vs projection)`)
  }

  const contenders = recap.playoffOdds.filter((t) => t.odds > 0 && t.odds < 100)
  if (contenders.length) {
    lines.push(`Playoff odds: ${recap.playoffOdds.map((t) => `${t.abbreviation} ${t.odds}%`).join(' · ')}`)
  }

  lines.push('Full recap on the home page.')
  return lines.join('\n')
}
