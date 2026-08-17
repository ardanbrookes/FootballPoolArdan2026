/**
 * Seed a demo league.
 *
 * Pulls the real player pool from Sleeper and the real schedule from ESPN, then
 * creates ten managers, auto-drafts their rosters, and builds a round-robin
 * season.
 *
 * Runs as an admin endpoint rather than a CLI script, because in Workers the
 * only thing holding a D1 binding is the Worker itself. See routes/admin.js.
 */

import { get, query, run, batch, stmt } from './db.js'
import { createUser } from './services/auth.js'
import { syncPlayers, fetchState, recordSync } from './services/sleeper.js'
import { rosterSlots, roster as rosterConfig } from './config.js'
import { ensureLineupRows } from './services/roster.js'

export const DEMO_PASSWORD = 'football'

/**
 * Eight managers. Eight teams is a happy number here: 14 regular-season weeks is
 * exactly a double round-robin (everyone plays everyone twice), and every week
 * has four matchups, which lays out evenly on screen.
 */
const MANAGERS = [
  { username: 'ardan', displayName: 'Ardan', team: 'Gridiron Gurus', abbr: 'GG', commissioner: true },
  { username: 'sam', displayName: 'Sam', team: 'End Zone Enforcers', abbr: 'EZE' },
  { username: 'jordan', displayName: 'Jordan', team: 'Blitz Brigade', abbr: 'BB' },
  { username: 'casey', displayName: 'Casey', team: 'Hail Mary Heroes', abbr: 'HMH' },
  { username: 'riley', displayName: 'Riley', team: 'Pocket Passers', abbr: 'PP' },
  { username: 'morgan', displayName: 'Morgan', team: 'Red Zone Raiders', abbr: 'RZR' },
  { username: 'avery', displayName: 'Avery', team: 'Turnover Titans', abbr: 'TT' },
  { username: 'quinn', displayName: 'Quinn', team: 'Snap Judgment', abbr: 'SJ' },
]

const CLEAR_TABLES = [
  'trade_items',
  'trades',
  'waiver_claims',
  'transactions',
  'lineups',
  'roster_players',
  'player_pool_state',
  'matchups',
  'teams',
  'sessions',
  'users',
  'league_settings',
  'leagues',
]

export async function seedLeague({ force = false, log = console.log } = {}) {
  const existing = await get('SELECT id FROM leagues LIMIT 1')
  if (existing && !force) {
    return { skipped: true, message: 'A league already exists. Pass force to wipe and reseed.' }
  }

  if (existing && force) {
    log('[seed] clearing existing league data')
    await batch(CLEAR_TABLES.map((table) => stmt(`DELETE FROM ${table}`)))
    // AUTOINCREMENT keeps counting after a DELETE; clear the high-water marks
    // so a reseeded demo starts back at id 1.
    await run("DELETE FROM sqlite_sequence WHERE name NOT IN ('players','nfl_games','player_stats')")
  }

  log('[seed] fetching NFL state from Sleeper...')
  const state = await fetchState()
  // Seed against the regular season even if we're currently in preseason.
  const season = Number(state.season)
  const week = state.season_type === 'regular' ? Number(state.week) || 1 : 1

  log('[seed] syncing player pool from Sleeper...')
  const players = await syncPlayers({ force: true })
  log(`[seed]   ${players.count ?? 'cached'} players`)

  // The schedule is loaded separately from a generated SQL file, because ESPN
  // blocks requests from workerd — see scripts/build-schedule.mjs.
  const { games } = await get(
    "SELECT COUNT(*) AS games FROM nfl_games WHERE season = @season AND season_type = 'regular'",
    { season },
  )
  log(`[seed] ${games} NFL games already loaded for ${season}`)
  if (games === 0) {
    log('[seed] WARNING: no schedule loaded — the Thursday-night lock has nothing to key off.')
    log('[seed]          Run: npm run schedule:build && npm run schedule:load:local')
  }

  const { lastInsertRowid: leagueId } = await run(
    // draft_url is left NULL: the League page hides the link when it's unset,
    // which beats shipping a placeholder that 404s. Set it once the real Sleeper
    // draft exists — see the commissioner settings endpoint.
    `INSERT INTO leagues (name, season, season_type, current_week, playoff_week, rules_url, draft_url)
     VALUES (@name, @season, 'regular', @week, 15, '/rules', NULL)`,
    { name: 'Football Pool 2026', season, week },
  )

  log('[seed] creating managers and teams...')
  const teams = []
  for (const [index, manager] of MANAGERS.entries()) {
    const user = await createUser({
      username: manager.username,
      displayName: manager.displayName,
      password: DEMO_PASSWORD,
      isCommissioner: Boolean(manager.commissioner),
    })
    const { lastInsertRowid: teamId } = await run(
      `INSERT INTO teams (league_id, user_id, name, abbreviation, waiver_order_seed)
       VALUES (@leagueId, @userId, @name, @abbr, @seed)`,
      { leagueId, userId: user.id, name: manager.team, abbr: manager.abbr, seed: index },
    )
    teams.push({ id: teamId, name: manager.team })
  }

  log('[seed] auto-drafting rosters...')
  await autoDraft(leagueId, season, week, teams)

  log('[seed] building the season schedule...')
  await buildRoundRobin(leagueId, season, teams)

  // Undrafted players are FREE AGENTS, not on waivers.
  //
  // A league that has just drafted is in the open window — the waiver cycle
  // hasn't started yet, so there's nothing for anyone to have been dropped from.
  // Putting them on waivers made a freshly seeded league look broken: the phase
  // reads "open" while every single player is claim-only until Tuesday.
  // The pool moves to waivers on its own at the first Sunday lock.
  await run('DELETE FROM player_pool_state WHERE league_id = @leagueId', { leagueId })
  const freeAgents = await get(
    `SELECT COUNT(*) AS count FROM players p
       LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
      WHERE rp.team_id IS NULL`,
    { leagueId },
  )
  log(`[seed] ${freeAgents.count} undrafted players are free agents`)

  // Mark this cycle's scheduled jobs as already handled. Without this the very
  // next cron tick would see "the week boundary has passed and never ran" and
  // immediately roll a freshly seeded week 1 into week 2.
  await recordSync(`tick:week-reset:${leagueId}`, 'ok', 'seeded')
  await recordSync(`tick:waivers:${leagueId}`, 'ok', 'seeded')
  await recordSync(`tick:pool-close:${leagueId}`, 'ok', 'seeded')

  return {
    skipped: false,
    leagueId,
    season,
    week,
    managers: MANAGERS.map((m) => m.username),
    password: DEMO_PASSWORD,
    players: players.count,
    games,
    freeAgents: freeAgents.count,
  }
}

function eligible(player) {
  try {
    const parsed = JSON.parse(player.fantasy_positions || '[]')
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch {
    /* fall through */
  }
  return player.position ? [player.position] : []
}

/** Snake draft by Sleeper's search_rank, filling starter slots before the bench. */
async function autoDraft(leagueId, season, week, teams) {
  // Sleeper leaves team defenses unranked (search_rank 999999), so they'd never
  // survive a plain rank cutoff — include them explicitly.
  const pool = await query(
    `SELECT id, full_name, position, fantasy_positions, nfl_team FROM players
      WHERE position = 'DEF'
         OR (search_rank IS NOT NULL AND search_rank < 900000 AND nfl_team IS NOT NULL)
      ORDER BY search_rank ASC
      LIMIT 1200`,
  )

  const taken = new Set()
  const rosters = new Map(teams.map((t) => [t.id, []]))
  const slotNeeds = new Map(teams.map((t) => [t.id, rosterSlots.map((s) => ({ ...s }))]))

  for (let round = 0; round < rosterConfig.maxPlayers; round += 1) {
    const order = round % 2 === 0 ? teams : [...teams].reverse()

    for (const team of order) {
      const needs = slotNeeds.get(team.id)
      const openSlot = needs.find((s) => !s.filled)
      const available = (player) => !taken.has(player.id)

      let pick = openSlot
        ? pool.find((p) => available(p) && eligible(p).some((pos) => openSlot.eligible.includes(pos)))
        : pool.find(available)
      let assignedSlot = pick && openSlot ? openSlot.slot : null

      if (!pick && openSlot) {
        // Nobody left who fits this slot. Retire it so it can't stall every
        // remaining round, and spend the pick on the best player available
        // instead — who goes to the bench, not into the slot we gave up on.
        openSlot.filled = true
        pick = pool.find(available)
        assignedSlot = null
      }
      if (!pick) continue

      taken.add(pick.id)
      rosters.get(team.id).push({ player: pick, slot: assignedSlot })
      if (openSlot) openSlot.filled = true
    }
  }

  for (const [teamId, picks] of rosters) {
    await ensureLineupRows(leagueId, teamId, season, week)

    const writes = []
    for (const { player, slot } of picks) {
      writes.push(
        stmt(
          `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via)
           VALUES (@leagueId, @teamId, @playerId, 'draft')`,
          { leagueId, teamId, playerId: player.id },
        ),
        stmt(
          `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
           VALUES (@leagueId, @teamId, 'add', 'draft', @playerId, @season, @week, 'Draft')`,
          { leagueId, teamId, playerId: player.id, season, week },
        ),
      )
      if (slot) {
        writes.push(
          stmt(
            `UPDATE lineups SET player_id = @playerId
              WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
                AND week = @week AND slot = @slot`,
            { leagueId, teamId, season, week, slot, playerId: player.id },
          ),
        )
      }
    }
    await batch(writes)
  }
}

/** Circle-method round robin across the regular season. */
async function buildRoundRobin(leagueId, season, teams, weeks = 14) {
  const ids = teams.map((t) => t.id)
  if (ids.length % 2 === 1) ids.push(null) // bye

  const rotation = [...ids]
  const writes = []

  for (let week = 1; week <= weeks; week += 1) {
    const half = rotation.length / 2
    for (let i = 0; i < half; i += 1) {
      const home = rotation[i]
      const away = rotation[rotation.length - 1 - i]
      if (home == null || away == null) continue

      // Alternate home/away by week so nobody hosts every game.
      const [homeId, awayId] = week % 2 === 0 ? [away, home] : [home, away]
      writes.push(
        stmt(
          `INSERT INTO matchups (league_id, season, week, home_team_id, away_team_id, status)
           VALUES (@leagueId, @season, @week, @homeId, @awayId, 'scheduled')`,
          { leagueId, season, week, homeId, awayId },
        ),
      )
    }
    // Rotate all but the first element.
    rotation.splice(1, 0, rotation.pop())
  }

  await batch(writes)
}
