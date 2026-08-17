/**
 * Import a drafted league from Sleeper.
 *
 * The intended workflow is: draft on Sleeper (it has a proper draft room), then
 * import once and run the season here. This is deliberately NOT a continuous
 * sync — Sleeper doesn't implement TSLC waivers, the Monday-night reset or the
 * Thursday partial lock, so keeping both in step would mean one is always wrong.
 *
 * What makes this simple: we already store Sleeper's player_id as our primary
 * key, so rosters map by direct id lookup. No name matching.
 *
 * Everything runs as a dry run unless `commit` is set, and the report is the same
 * shape either way — so the preview genuinely reflects what a commit would do.
 */

import { get, query, run, batch, stmt } from '../db.js'
import { getSleeperConfig, rosterSlots, roster as rosterConfig } from '../config.js'

/** Sleeper marks empty starter slots with "0". */
const EMPTY_SLOT = '0'

/** Does this injury designation qualify for our IR slot? */
const isIrEligibleStatus = (status) =>
  Boolean(status) && rosterConfig.irEligibleStatuses.includes(status)

async function sleeperFetch(path) {
  const { baseUrl } = getSleeperConfig()
  const res = await fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${path}`)
  return res.json()
}

/**
 * Pull everything we need in one go.
 * Exported so tests can substitute a fixture without touching the network.
 */
export async function fetchSleeperLeague(sleeperLeagueId) {
  const league = await sleeperFetch(`/league/${sleeperLeagueId}`)
  if (!league) {
    const err = new Error(
      `Sleeper league ${sleeperLeagueId} not found. Check the id in your Sleeper league URL.`,
    )
    err.status = 404
    throw err
  }

  const [users, rosters, drafts] = await Promise.all([
    sleeperFetch(`/league/${sleeperLeagueId}/users`),
    sleeperFetch(`/league/${sleeperLeagueId}/rosters`),
    sleeperFetch(`/league/${sleeperLeagueId}/drafts`),
  ])

  // Picks are only used for the transaction log, so a failure here isn't fatal.
  let picks = []
  const draftId = drafts?.[0]?.draft_id
  if (draftId) {
    picks = (await sleeperFetch(`/draft/${draftId}/picks`).catch(() => null)) || []
  }

  return { league, users: users || [], rosters: rosters || [], picks, draftId: draftId || null }
}

/**
 * Match each Sleeper manager to one of our teams.
 *
 * Tries display name, then the team name they set on Sleeper, then username.
 * Anything left over is reported rather than guessed — a wrong mapping would
 * hand someone else's draft to the wrong manager.
 */
function matchManagers(sleeperUsers, ourTeams, overrides = {}) {
  const norm = (v) => (v || '').toString().trim().toLowerCase()
  const available = new Map(ourTeams.map((t) => [t.id, t]))
  const matched = []
  const unmatched = []

  for (const user of sleeperUsers) {
    const forced = overrides[user.user_id]
    if (forced != null) {
      const team = available.get(Number(forced))
      if (team) {
        matched.push({ sleeper: user, team, via: 'override' })
        available.delete(team.id)
        continue
      }
    }

    const sleeperName = norm(user.display_name)
    const sleeperTeam = norm(user.metadata?.team_name)

    const candidates = [
      ['display name', (t) => norm(t.manager_display_name) === sleeperName],
      ['username', (t) => norm(t.username) === sleeperName],
      ['team name', (t) => sleeperTeam && norm(t.name) === sleeperTeam],
    ]

    let found = null
    let via = null
    for (const [label, predicate] of candidates) {
      found = [...available.values()].find(predicate)
      if (found) {
        via = label
        break
      }
    }

    if (found) {
      matched.push({ sleeper: user, team: found, via })
      available.delete(found.id)
    } else {
      unmatched.push(user)
    }
  }

  return { matched, unmatched, unclaimedTeams: [...available.values()] }
}

/**
 * Work out which of our lineup slots each imported starter should fill.
 *
 * If the Sleeper league's starting positions line up with ours, Sleeper's
 * `starters` array maps across by index. Otherwise fall back to filling our
 * slots by position eligibility, which is slower to reason about but never
 * silently puts a kicker at quarterback.
 */
function assignLineup(sleeperLeague, starters, playersById) {
  const sleeperPositions = (sleeperLeague.roster_positions || []).filter(
    (p) => p !== 'BN' && p !== 'IR' && p !== 'TAXI',
  )

  const ourPositions = rosterSlots.map((s) => (s.slot === 'DEF' ? 'DEF' : s.slot.replace(/\d+$/, '')))
  const alignsByIndex =
    sleeperPositions.length === ourPositions.length &&
    sleeperPositions.every((pos, i) => {
      const ours = ourPositions[i]
      // Sleeper writes D/ST as DEF and flex as FLEX, same as us.
      return pos === ours || (pos === 'SUPER_FLEX' && ours === 'FLEX')
    })

  const assignments = {}
  const leftovers = []

  if (alignsByIndex) {
    rosterSlots.forEach((slot, i) => {
      const id = starters[i]
      assignments[slot.slot] = id && id !== EMPTY_SLOT && playersById.has(id) ? id : null
    })
    return { assignments, leftovers, method: 'index' }
  }

  // Eligibility fill: walk our slots, take the first unused starter that fits.
  const pool = starters.filter((id) => id && id !== EMPTY_SLOT && playersById.has(id))
  const used = new Set()

  for (const slot of rosterSlots) {
    const pick = pool.find((id) => {
      if (used.has(id)) return false
      const player = playersById.get(id)
      const positions = player.fantasyPositions.length ? player.fantasyPositions : [player.position]
      return positions.some((p) => slot.eligible.includes(p))
    })
    assignments[slot.slot] = pick ?? null
    if (pick) used.add(pick)
  }

  for (const id of pool) if (!used.has(id)) leftovers.push(id)
  return { assignments, leftovers, method: 'eligibility' }
}

/**
 * Import a Sleeper league's rosters into ours.
 *
 * @param {object} opts
 * @param {number} opts.leagueId          our league id
 * @param {string} opts.sleeperLeagueId   the id from the Sleeper URL
 * @param {object} [opts.managerMap]      { sleeperUserId: ourTeamId } overrides
 * @param {boolean} [opts.commit]         false (default) reports without writing
 * @param {boolean} [opts.importTeamNames] adopt Sleeper team names
 * @param {object} [opts.payload]         pre-fetched Sleeper data, for tests
 */
export async function importSleeperLeague({
  leagueId,
  sleeperLeagueId,
  managerMap = {},
  commit = false,
  importTeamNames = false,
  payload = null,
}) {
  const ourLeague = await get('SELECT id, season, current_week FROM leagues WHERE id = @leagueId', {
    leagueId,
  })
  if (!ourLeague) {
    const err = new Error('League not found.')
    err.status = 404
    throw err
  }

  const data = payload || (await fetchSleeperLeague(sleeperLeagueId))

  const ourTeams = await query(
    `SELECT t.id, t.name, t.abbreviation, u.username, u.display_name AS manager_display_name
       FROM teams t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.league_id = @leagueId ORDER BY t.id ASC`,
    { leagueId },
  )

  const { matched, unmatched, unclaimedTeams } = matchManagers(data.users, ourTeams, managerMap)

  // Roster lookup, so we can flag anyone Sleeper knows about and we don't.
  const playerRows = await query(
    'SELECT id, full_name, position, fantasy_positions, injury_status FROM players',
  )
  const injuryStatusById = new Map(playerRows.map((p) => [p.id, p.injury_status]))
  const knownPlayers = new Map(
    playerRows.map((p) => [
      p.id,
      {
        id: p.id,
        name: p.full_name,
        position: p.position,
        fantasyPositions: (() => {
          try {
            return JSON.parse(p.fantasy_positions || '[]')
          } catch {
            return []
          }
        })(),
      },
    ]),
  )

  const rosterByOwner = new Map(data.rosters.map((r) => [r.owner_id, r]))
  const warnings = []
  const missingPlayers = new Set()
  const teamReports = []
  /** Roster clears, which must all run before any insert. */
  const clears = []
  const writes = []
  const importedPlayerIds = new Set()

  for (const { sleeper, team, via } of matched) {
    const sleeperRoster = rosterByOwner.get(sleeper.user_id)
    if (!sleeperRoster) {
      warnings.push(`${sleeper.display_name} has no roster on Sleeper — ${team.name} left untouched.`)
      continue
    }

    const allIds = sleeperRoster.players || []
    const reserve = new Set(sleeperRoster.reserve || [])
    const starters = sleeperRoster.starters || []

    const present = allIds.filter((id) => knownPlayers.has(id))
    for (const id of allIds) if (!knownPlayers.has(id)) missingPlayers.add(id)

    const active = present.filter((id) => !reserve.has(id))
    const onIr = present.filter((id) => reserve.has(id))

    if (active.length > rosterConfig.maxPlayers) {
      warnings.push(
        `${team.name} would have ${active.length} active players, over the ${rosterConfig.maxPlayers} limit.`,
      )
    }
    if (onIr.length > rosterConfig.irSlots) {
      warnings.push(
        `${team.name} has ${onIr.length} players on Sleeper's IR but we only have ${rosterConfig.irSlots} slot(s).`,
      )
    }

    // Sleeper's IR eligibility is its own thing and may be looser than ours. Rather
    // than silently granting a free roster spot, import the player and say so —
    // the roster view also marks them "healthy" until activated or dropped.
    const ineligibleOnIr = onIr.filter((id) => !isIrEligibleStatus(injuryStatusById.get(id)))
    if (ineligibleOnIr.length) {
      const names = ineligibleOnIr.map((id) => knownPlayers.get(id).name)
      const plural = names.length > 1
      warnings.push(
        `${team.name}: ${names.join(', ')} ${plural ? 'are' : 'is'} on Sleeper's IR but ` +
          `${plural ? "aren't" : "isn't"} injured by our rules — ` +
          `${plural ? "they'll" : "they'll"} be flagged for activation rather than occupying IR for free.`,
      )
    }

    const { assignments, leftovers, method } = assignLineup(data.league, starters, knownPlayers)
    if (leftovers.length) {
      warnings.push(
        `${team.name}: ${leftovers.length} starter(s) from Sleeper didn't fit our slots and went to the bench.`,
      )
    }

    for (const id of present) importedPlayerIds.add(id)

    teamReports.push({
      teamId: team.id,
      teamName: team.name,
      sleeperManager: sleeper.display_name,
      sleeperTeamName: sleeper.metadata?.team_name ?? null,
      matchedVia: via,
      players: present.length,
      active: active.length,
      onIr: onIr.length,
      lineupMethod: method,
      starters: rosterSlots.map((slot) => ({
        slot: slot.slot,
        playerId: assignments[slot.slot],
        playerName: assignments[slot.slot] ? knownPlayers.get(assignments[slot.slot]).name : null,
      })),
    })

    if (!commit) continue

    // Clearing is collected separately and runs before ANY insert. Doing it
    // per-team inline meant one team's insert could hit a player still sitting
    // on another team whose delete hadn't run yet — `roster_players` is unique
    // on (league_id, player_id), so that's a constraint violation. It matters
    // more now that large batches are chunked into separate transactions.
    clears.push(
      stmt('DELETE FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId', {
        leagueId,
        teamId: team.id,
      }),
    )

    for (const playerId of present) {
      writes.push(
        stmt(
          `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via, on_ir)
           VALUES (@leagueId, @teamId, @playerId, 'draft', @onIr)`,
          { leagueId, teamId: team.id, playerId, onIr: reserve.has(playerId) ? 1 : 0 },
        ),
      )
      writes.push(
        stmt(
          `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
           VALUES (@leagueId, @teamId, 'add', 'draft', @playerId, @season, @week, 'Imported from Sleeper draft')`,
          {
            leagueId,
            teamId: team.id,
            playerId,
            season: ourLeague.season,
            week: ourLeague.current_week,
          },
        ),
      )
    }

    for (const slot of rosterSlots) {
      writes.push(
        stmt(
          `INSERT INTO lineups (league_id, team_id, season, week, slot, player_id)
           VALUES (@leagueId, @teamId, @season, @week, @slot, @playerId)
           ON CONFLICT (league_id, team_id, season, week, slot)
           DO UPDATE SET player_id = excluded.player_id`,
          {
            leagueId,
            teamId: team.id,
            season: ourLeague.season,
            week: ourLeague.current_week,
            slot: slot.slot,
            playerId: assignments[slot.slot],
          },
        ),
      )
    }

    if (importTeamNames && sleeper.metadata?.team_name) {
      writes.push(
        stmt('UPDATE teams SET name = @name WHERE id = @teamId', {
          name: sleeper.metadata.team_name,
          teamId: team.id,
        }),
      )
    }
  }

  if (unmatched.length) {
    warnings.push(
      `${unmatched.length} Sleeper manager(s) couldn't be matched: ` +
        `${unmatched.map((u) => u.display_name).join(', ')}. Supply managerMap to place them.`,
    )
  }
  if (missingPlayers.size) {
    warnings.push(
      `${missingPlayers.size} drafted player(s) aren't in our player table — run a player sync ` +
        'and re-import. They were skipped.',
    )
  }

  let poolReset = 0
  if (commit) {
    // Two sequential batches, in this order for a reason:
    //
    //   1. Clear every affected roster, THEN insert. Interleaving them let one
    //      team's insert collide with a player still on another team, violating
    //      the unique (league_id, player_id) constraint.
    //   2. Only once rosters are settled can we tell who is actually unrostered.
    //      Computing that first would miss anyone the import dropped, leaving
    //      them neither rostered nor on waivers.
    await batch([...clears, ...writes])

    // Undrafted players become FREE AGENTS, not waivers. A league that has just
    // drafted is in the open window — nobody has been dropped yet, so there's
    // nothing to clear. The pool moves to waivers on its own at the first Sunday
    // lock. Clearing the table is also what releases anyone the import dropped.
    await run('DELETE FROM player_pool_state WHERE league_id = @leagueId', { leagueId })
    const unrostered = await get(
      `SELECT COUNT(*) AS count FROM players p
         LEFT JOIN roster_players rp ON rp.player_id = p.id AND rp.league_id = @leagueId
        WHERE rp.team_id IS NULL`,
      { leagueId },
    )
    poolReset = unrostered.count
  }

  return {
    dryRun: !commit,
    sleeperLeague: {
      id: data.league.league_id,
      name: data.league.name,
      season: data.league.season,
      totalRosters: data.league.total_rosters,
      rosterPositions: data.league.roster_positions,
      scoringRec: data.league.scoring_settings?.rec ?? null,
      draftId: data.draftId,
      picks: data.picks.length,
    },
    ourLeague: { id: ourLeague.id, season: ourLeague.season, week: ourLeague.current_week },
    matchedManagers: matched.length,
    unmatchedManagers: unmatched.map((u) => ({ userId: u.user_id, displayName: u.display_name })),
    unclaimedTeams: unclaimedTeams.map((t) => ({ id: t.id, name: t.name })),
    missingPlayerIds: [...missingPlayers],
    teams: teamReports,
    warnings,
    poolResetToWaivers: poolReset,
    /** Sanity checks worth eyeballing before committing. */
    settingsComparison: {
      teams: { sleeper: data.league.total_rosters, ours: ourTeams.length },
      receptionPoints: { sleeper: data.league.scoring_settings?.rec ?? null, ours: 0.5 },
      benchSlots: {
        sleeper: (data.league.roster_positions || []).filter((p) => p === 'BN').length,
        ours: rosterConfig.benchSize,
      },
      irSlots: {
        sleeper: (data.league.roster_positions || []).filter((p) => p === 'IR').length,
        ours: rosterConfig.irSlots,
      },
    },
  }
}
