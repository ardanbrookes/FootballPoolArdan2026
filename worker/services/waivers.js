/**
 * Waiver wire — submission and TSLC processing.
 *
 * Priority is Time Since Last Claim: the team that has gone longest without
 * winning a claim picks first. A team that has never won one sorts to the very
 * front. Ties break toward the worse record, then fewer points scored, then a
 * stable per-team seed so the order is never ambiguous.
 *
 * Processing is a single pass with re-sorting:
 *
 *   1. Recompute the order (successes during this run change it).
 *   2. Take the highest-priority team that still has a pending claim.
 *   3. Resolve that team's own #1 remaining claim.
 *   4. On success, stamp last_waiver_claim_at = now, dropping them to the back.
 *   5. Repeat until no pending claims remain.
 *   6. Everyone left unrostered clears waivers and becomes a free agent.
 *
 * That gives every team a turn before anyone gets a second bite, which is the
 * point of a rolling-priority system.
 *
 * The whole run is decided against an in-memory simulation of league state, and
 * only then written — which is what makes it expressible as one atomic D1
 * batch, since D1 has no interactive transactions.
 */

import { get, query, run, batch, stmt, nowIso } from '../db.js'
import { roster as rosterConfig } from '../config.js'
import { getWaiverConfig } from './settings.js'
import { acquisitionStatements, getRosterCount, isIrEligible } from './roster.js'
import { AVAILABILITY, getPlayerWithAvailability, nextWaiverClearTime, statements as poolStatements } from './players.js'

export const CLAIM_STATUS = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

/** Current waiver priority order, best pick first. */
export function getWaiverOrder(leagueId) {
  return query(
    `SELECT t.id, t.name, t.abbreviation, t.last_waiver_claim_at,
            t.wins, t.losses, t.ties, t.points_for,
            u.display_name AS manager
       FROM teams t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.league_id = @leagueId
      ORDER BY
        CASE WHEN t.last_waiver_claim_at IS NULL THEN 0 ELSE 1 END ASC,
        t.last_waiver_claim_at ASC,
        (CAST(t.wins AS REAL) + t.ties * 0.5) /
          CASE WHEN (t.wins + t.losses + t.ties) = 0 THEN 1
               ELSE (t.wins + t.losses + t.ties) END ASC,
        t.points_for ASC,
        t.waiver_order_seed ASC,
        t.id ASC`,
    { leagueId },
  )
}

export function getPendingClaims(leagueId, teamId = null) {
  const sql = `
    SELECT c.*, ap.full_name AS add_player_name, ap.position AS add_position, ap.nfl_team AS add_nfl_team,
           ap.injury_status AS add_injury_status,
           dp.full_name AS drop_player_name, dp.position AS drop_position,
           t.name AS team_name, t.abbreviation AS team_abbr
      FROM waiver_claims c
      JOIN players ap ON ap.id = c.add_player_id
      LEFT JOIN players dp ON dp.id = c.drop_player_id
      JOIN teams t ON t.id = c.team_id
     WHERE c.league_id = @leagueId AND c.status = 'pending'
       ${teamId ? 'AND c.team_id = @teamId' : ''}
     ORDER BY c.team_id ASC, c.priority ASC`
  return query(sql, teamId ? { leagueId, teamId } : { leagueId })
}

/** Processed claims, newest first — the "waiver results" feed. */
export function getWaiverResults(leagueId, { season, week, limit = 100 } = {}) {
  const filters = ["c.status != 'pending'"]
  const params = { leagueId, limit }
  if (season != null) {
    filters.push('c.season = @season')
    params.season = season
  }
  if (week != null) {
    filters.push('c.week = @week')
    params.week = week
  }

  return query(
    `SELECT c.id, c.team_id, c.season, c.week, c.priority, c.status, c.result_reason, c.processed_at, c.to_ir,
            ap.full_name AS add_player_name, ap.position AS add_position, ap.nfl_team AS add_nfl_team,
            dp.full_name AS drop_player_name,
            t.name AS team_name, t.abbreviation AS team_abbr
       FROM waiver_claims c
       JOIN players ap ON ap.id = c.add_player_id
       LEFT JOIN players dp ON dp.id = c.drop_player_id
       JOIN teams t ON t.id = c.team_id
      WHERE c.league_id = @leagueId AND ${filters.join(' AND ')}
      ORDER BY c.processed_at DESC, c.priority ASC
      LIMIT @limit`,
    params,
  )
}

/** Queue a claim. Priority defaults to the end of this team's list. */
export async function submitClaim({
  leagueId,
  teamId,
  season,
  week,
  addPlayerId,
  dropPlayerId = null,
  priority,
  toIr = false,
}) {
  const config = await getWaiverConfig(leagueId)

  const target = await getPlayerWithAvailability(leagueId, addPlayerId)
  if (!target) throw httpError('Player not found.', 404)
  if (target.availability === AVAILABILITY.ROSTERED) {
    throw httpError(`${target.full_name} is already rostered by ${target.owner_team_name}.`, 409)
  }

  const existing = await get(
    `SELECT id FROM waiver_claims
      WHERE league_id = @leagueId AND team_id = @teamId AND add_player_id = @addPlayerId
        AND status = 'pending'`,
    { leagueId, teamId, addPlayerId },
  )
  if (existing) throw httpError(`You already have a pending claim for ${target.full_name}.`, 409)

  const { count: pendingCount } = await get(
    "SELECT COUNT(*) AS count FROM waiver_claims WHERE league_id = @leagueId AND team_id = @teamId AND status = 'pending'",
    { leagueId, teamId },
  )
  if (pendingCount >= config.maxClaimsPerTeam) {
    throw httpError(`You can have at most ${config.maxClaimsPerTeam} pending claims.`, 409)
  }

  if (dropPlayerId) {
    const owned = await get(
      'SELECT 1 AS ok FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @playerId',
      { leagueId, teamId, playerId: dropPlayerId },
    )
    if (!owned) throw httpError('The drop candidate is not on your roster.', 400)
  } else if (!toIr && (await getRosterCount(leagueId, teamId)) >= rosterConfig.maxPlayers) {
    throw httpError(
      `Your roster is full (${rosterConfig.maxPlayers}) — every claim needs a drop candidate.`,
      409,
      'DROP_REQUIRED',
    )
  }

  // Claiming straight onto IR. Eligibility is checked again at processing time,
  // because a player can be activated between submitting and Tuesday morning.
  if (toIr && !isIrEligible(target)) {
    throw httpError(
      `${target.full_name} doesn't qualify for IR (${target.injury_status || 'no injury designation'}).`,
      409,
      'NOT_IR_ELIGIBLE',
    )
  }

  const result = await run(
    `INSERT INTO waiver_claims (league_id, team_id, season, week, add_player_id, drop_player_id, priority, to_ir)
     VALUES (@leagueId, @teamId, @season, @week, @addPlayerId, @dropPlayerId, @priority, @toIr)`,
    {
      leagueId,
      teamId,
      season,
      week,
      addPlayerId,
      dropPlayerId,
      priority: priority ?? pendingCount + 1,
      toIr: toIr ? 1 : 0,
    },
  )

  return get('SELECT * FROM waiver_claims WHERE id = @id', { id: result.lastInsertRowid })
}

export async function cancelClaim({ leagueId, teamId, claimId }) {
  const claim = await get(
    "SELECT * FROM waiver_claims WHERE id = @claimId AND league_id = @leagueId AND status = 'pending'",
    { claimId, leagueId },
  )
  if (!claim) throw httpError('Claim not found.', 404)
  if (claim.team_id !== teamId) throw httpError('That claim belongs to another team.', 403)

  await run("UPDATE waiver_claims SET status = 'cancelled', processed_at = @at WHERE id = @claimId", {
    claimId,
    at: nowIso(),
  })
  return { cancelled: claimId }
}

/** Reorder a team's pending claims. `claimIds` is the new order, most-wanted first. */
export async function reorderClaims({ leagueId, teamId, claimIds }) {
  const pending = await getPendingClaims(leagueId, teamId)
  const validIds = new Set(pending.map((c) => c.id))
  if (claimIds.length !== validIds.size || claimIds.some((id) => !validIds.has(id))) {
    throw httpError('Reorder must list every pending claim exactly once.', 400)
  }

  await batch(
    claimIds.map((claimId, index) =>
      stmt('UPDATE waiver_claims SET priority = @priority WHERE id = @claimId', {
        claimId,
        priority: index + 1,
      }),
    ),
  )

  return getPendingClaims(leagueId, teamId)
}

/**
 * Resolve every pending claim for a league.
 *
 * @param {number} leagueId
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] compute results without writing anything
 */
export async function processWaivers(leagueId, { dryRun = false } = {}) {
  const config = await getWaiverConfig(leagueId)
  const league = await get('SELECT id, season, current_week FROM leagues WHERE id = @leagueId', { leagueId })
  if (!league) throw httpError('League not found.', 404)

  const startingOrder = await getWaiverOrder(leagueId)
  const dropClearAt = await nextWaiverClearTime(leagueId)
  const processed = []
  const writes = []

  // --- Load everything the simulation needs up front ---
  const claimsByTeam = new Map()
  for (const claim of await getPendingClaims(leagueId)) {
    if (!claimsByTeam.has(claim.team_id)) claimsByTeam.set(claim.team_id, [])
    claimsByTeam.get(claim.team_id).push(claim)
  }
  for (const list of claimsByTeam.values()) list.sort((a, b) => a.priority - b.priority)

  const rosterRows = await query(
    'SELECT player_id, team_id, on_ir FROM roster_players WHERE league_id = @leagueId',
    { leagueId },
  )
  const ownership = new Map(rosterRows.map((r) => [r.player_id, r.team_id]))
  // Who currently occupies an IR slot, so a claim that drops one of them can
  // take the spot it frees rather than being told IR is full.
  const onIr = new Set(rosterRows.filter((r) => r.on_ir).map((r) => r.player_id))
  const rosterCounts = new Map(
    (
      await query(
        `SELECT team_id, COUNT(*) AS count FROM roster_players
          WHERE league_id = @leagueId AND on_ir = 0 GROUP BY team_id`,
        { leagueId },
      )
    ).map((r) => [r.team_id, r.count]),
  )

  // Tracked alongside the active count so a run can't overfill the IR either.
  const irCounts = new Map(
    (
      await query(
        `SELECT team_id, COUNT(*) AS count FROM roster_players
          WHERE league_id = @leagueId AND on_ir = 1 GROUP BY team_id`,
        { leagueId },
      )
    ).map((r) => [r.team_id, r.count]),
  )

  const tslc = new Map(startingOrder.map((t) => [t.id, t.last_waiver_claim_at]))
  const teamMeta = new Map(startingOrder.map((t) => [t.id, t]))

  const orderedTeamIds = () =>
    [...claimsByTeam.keys()]
      .filter((teamId) => claimsByTeam.get(teamId).length > 0)
      .sort((a, b) => {
        const aTs = tslc.get(a)
        const bTs = tslc.get(b)
        if (aTs !== bTs) {
          if (!aTs) return -1
          if (!bTs) return 1
          return aTs < bTs ? -1 : 1
        }
        const ta = teamMeta.get(a)
        const tb = teamMeta.get(b)
        const pct = (t) => {
          const games = t.wins + t.losses + t.ties
          return games ? (t.wins + t.ties * 0.5) / games : 0
        }
        return pct(ta) - pct(tb) || ta.points_for - tb.points_for || a - b
      })

  const resolve = (claim, status, reason) => {
    processed.push({
      claimId: claim.id,
      teamId: claim.team_id,
      teamName: claim.team_name,
      addPlayerId: claim.add_player_id,
      addPlayerName: claim.add_player_name,
      dropPlayerId: claim.drop_player_id,
      dropPlayerName: claim.drop_player_name,
      priority: claim.priority,
      status,
      reason,
    })
    writes.push(
      stmt(
        'UPDATE waiver_claims SET status = @status, result_reason = @reason, processed_at = @at WHERE id = @id',
        { id: claim.id, status, reason, at: nowIso() },
      ),
    )
  }

  // --- Simulate ---
  let guard = 0
  const maxIterations = 10_000

  while (guard++ < maxIterations) {
    const teamIds = orderedTeamIds()
    if (teamIds.length === 0) break

    const teamId = teamIds[0]
    const claim = claimsByTeam.get(teamId).shift()
    if (!claim) continue

    const currentOwner = ownership.get(claim.add_player_id)
    if (currentOwner != null) {
      resolve(
        claim,
        CLAIM_STATUS.FAILED,
        currentOwner === teamId
          ? 'You already acquired this player earlier in this run.'
          : 'Claimed by a higher-priority team.',
      )
      continue
    }

    if (claim.drop_player_id && ownership.get(claim.drop_player_id) !== teamId) {
      resolve(claim, CLAIM_STATUS.FAILED, 'Drop candidate was no longer on your roster.')
      continue
    }

    const toIr = Boolean(claim.to_ir)

    if (toIr) {
      // Re-checked here rather than trusted from submission time: a player can
      // be activated between Saturday night and Tuesday morning, and quietly
      // parking a healthy player on IR would be a free extra roster spot.
      if (!isIrEligible({ injury_status: claim.add_injury_status })) {
        resolve(
          claim,
          CLAIM_STATUS.FAILED,
          'No longer IR-eligible — they were activated before waivers ran.',
        )
        continue
      }
      const freed = claim.drop_player_id && onIr.has(claim.drop_player_id) ? 1 : 0
      if ((irCounts.get(teamId) ?? 0) - freed >= rosterConfig.irSlots) {
        resolve(claim, CLAIM_STATUS.FAILED, 'Your IR slot was already full.')
        continue
      }
    }

    const count = rosterCounts.get(teamId) ?? 0
    if (!toIr && !claim.drop_player_id && count >= rosterConfig.maxPlayers) {
      resolve(claim, CLAIM_STATUS.FAILED, 'Roster full and no drop candidate was set.')
      continue
    }

    // Claim succeeds.
    writes.push(
      ...acquisitionStatements({
        leagueId,
        teamId,
        season: league.season,
        week: league.current_week,
        addPlayerId: claim.add_player_id,
        dropPlayerId: claim.drop_player_id,
        source: 'waiver',
        notes: `Waiver claim #${claim.priority}${toIr ? ' (to IR)' : ''}`,
        dropClearAt,
        toIr,
      }),
    )

    ownership.set(claim.add_player_id, teamId)
    if (claim.drop_player_id) ownership.delete(claim.drop_player_id)
    // An IR arrival never touches the active count; a drop still frees a spot.
    if (toIr) {
      // Net zero when the dropped player was the IR occupant.
      const freedIr = claim.drop_player_id && onIr.has(claim.drop_player_id) ? 1 : 0
      irCounts.set(teamId, (irCounts.get(teamId) ?? 0) + 1 - freedIr)
      // Only an ACTIVE drop frees an active spot; dropping off IR does not.
      if (claim.drop_player_id && !freedIr) rosterCounts.set(teamId, count - 1)
      if (claim.drop_player_id) onIr.delete(claim.drop_player_id)
    } else {
      rosterCounts.set(teamId, count + (claim.drop_player_id ? 0 : 1))
    }

    const stamp = nowIso()
    if (config.resetPriorityOnWin) {
      tslc.set(teamId, stamp)
      writes.push(
        stmt('UPDATE teams SET last_waiver_claim_at = @at WHERE id = @teamId', { at: stamp, teamId }),
      )
    }

    resolve(claim, CLAIM_STATUS.SUCCESS, 'Claim awarded.')
  }

  // --- Commit ---
  let freedAgents = 0
  if (!dryRun) {
    await batch(writes)

    // Anything still unrostered clears waivers and hits the free agent pool.
    const stillOnWaivers = await query(
      `SELECT pps.player_id FROM player_pool_state pps
         LEFT JOIN roster_players rp ON rp.player_id = pps.player_id AND rp.league_id = pps.league_id
        WHERE pps.league_id = @leagueId AND rp.team_id IS NULL`,
      { leagueId },
    )
    const CHUNK = 200
    for (let i = 0; i < stillOnWaivers.length; i += CHUNK) {
      await batch(
        stillOnWaivers.slice(i, i + CHUNK).map((row) => poolStatements.clearWaiverState(leagueId, row.player_id)),
      )
    }
    freedAgents = stillOnWaivers.length
  }

  return {
    dryRun,
    season: league.season,
    week: league.current_week,
    order: startingOrder.map((t) => ({
      teamId: t.id,
      name: t.name,
      abbreviation: t.abbreviation,
      lastClaimAt: t.last_waiver_claim_at,
    })),
    processed,
    freedAgents,
    succeeded: processed.filter((p) => p.status === CLAIM_STATUS.SUCCESS).length,
    failed: processed.filter((p) => p.status === CLAIM_STATUS.FAILED).length,
  }
}
