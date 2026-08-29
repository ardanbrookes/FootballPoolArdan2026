/**
 * Roster and lineup management.
 *
 * Every mutating function here enforces the lock rules from services/locks.js.
 * The waiver processor deliberately bypasses them by calling the `*Unchecked`
 * helpers — it runs at 3am inside the open window, on the league's behalf.
 *
 * Writes are assembled as statement lists and submitted with `batch()`, because
 * D1 has no interactive transactions. Validation therefore happens entirely up
 * front: by the time we build statements, the operation is known to be legal.
 */

import { get, query, batch, stmt } from '../db.js'
import { rosterSlots, roster as rosterConfig } from '../config.js'
import { getLockState, isPlayerLocked, assertPlayerMovable, assertAllowed, playerLockReason } from './locks.js'
import { getWeekPoints, getWeekProjections } from './scoring.js'
import { getTeamGameStatus } from './schedule.js'
import { systemMessageStatement } from './chat.js'
import {
  AVAILABILITY,
  getPlayerWithAvailability,
  nextWaiverClearTime,
  statements as poolStatements,
} from './players.js'

const SLOT_BY_ID = new Map(rosterSlots.map((s) => [s.slot, s]))

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

function eligiblePositions(player) {
  try {
    const parsed = JSON.parse(player.fantasy_positions || '[]')
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch {
    // fall through
  }
  return player.position ? [player.position] : []
}

export function canPlayerFillSlot(player, slotId) {
  const slot = SLOT_BY_ID.get(slotId)
  if (!slot) return false
  return eligiblePositions(player).some((p) => slot.eligible.includes(p))
}

/** Full roster for a team: configured starter slots plus bench and IR. */
export async function getTeamRoster(leagueId, teamId, season, week, lockState) {
  const locks = lockState || (await getLockState(leagueId))

  // The NFL week actually being played, which is what decides whether a
  // player's number should read as a score or a projection.
  const nflWeek = locks.activeWeek ?? week

  const [points, projections, games, rostered, lineup] = await Promise.all([
    getWeekPoints(season, week),
    getWeekProjections(season, week),
    getTeamGameStatus(season, nflWeek).catch(() => new Map()),
    query(
      `SELECT p.id, p.full_name, p.position, p.fantasy_positions, p.nfl_team, p.injury_status,
              p.status, p.bye_week, p.jersey_number, rp.acquired_at, rp.acquired_via, rp.on_ir,
              rp.on_trade_block
         FROM roster_players rp
         JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.team_id = @teamId`,
      { leagueId, teamId },
    ),
    query(
      `SELECT slot, player_id FROM lineups
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season AND week = @week`,
      { leagueId, teamId, season, week },
    ),
  ])

  const slotByPlayer = new Map(lineup.filter((l) => l.player_id).map((l) => [l.player_id, l.slot]))
  const playerBySlot = new Map(lineup.filter((l) => l.player_id).map((l) => [l.slot, l.player_id]))

  const decorate = (player) => ({
    id: player.id,
    name: player.full_name,
    position: player.position,
    eligiblePositions: eligiblePositions(player),
    nflTeam: player.nfl_team,
    injuryStatus: player.injury_status,
    status: player.status,
    byeWeek: player.bye_week,
    jerseyNumber: player.jersey_number,
    acquiredAt: player.acquired_at,
    acquiredVia: player.acquired_via,
    onIr: Boolean(player.on_ir),
    onTradeBlock: Boolean(player.on_trade_block),
    points: points.get(player.id) ?? 0,
    projectedPoints: projections.get(player.id) ?? 0,
    /**
     * Has this player's game kicked off?
     *
     * Decides whether the UI shows what they scored or what they're projected
     * to score. Without it every player reads 0.0 all week, which is what made
     * the home page look broken while Acquisitions looked fine.
     */
    gameStarted: ['in_progress', 'final'].includes(
      games.get(player.nfl_team)?.status ?? 'scheduled',
    ),
    locked: isPlayerLocked(locks, player),
    lockReason: playerLockReason(locks, player),
  })

  const byId = new Map(rostered.map((p) => [p.id, p]))

  const starters = rosterSlots.map((slot) => {
    const playerId = playerBySlot.get(slot.slot)
    const player = playerId ? byId.get(playerId) : null
    return {
      slot: slot.slot,
      label: slot.label,
      eligible: slot.eligible,
      player: player ? decorate(player) : null,
    }
  })

  const bench = rostered
    .filter((p) => !slotByPlayer.has(p.id) && !p.on_ir)
    .map(decorate)
    .sort((a, b) => a.position?.localeCompare(b.position ?? '') || a.name.localeCompare(b.name))

  const irPlayers = rostered.filter((p) => p.on_ir)
  const ir = irPlayers.map((player) => ({
    ...decorate(player),
    // A player who has recovered is occupying IR without qualifying for it,
    // which is effectively a free bench spot. Surfaced rather than auto-removed:
    // forcing them onto the roster could push it over the limit.
    healthyOnIr: !isIrEligible(player),
  }))

  // IR players are held outside the roster limit.
  const activeCount = rostered.filter((p) => !p.on_ir).length

  return {
    teamId,
    season,
    week,
    starters,
    bench,
    ir,
    counts: {
      total: activeCount,
      max: rosterConfig.maxPlayers,
      starters: starters.filter((s) => s.player).length,
      starterSlots: rosterSlots.length,
      bench: bench.length,
      benchMax: rosterConfig.benchSize,
      ir: ir.length,
      irMax: rosterConfig.irSlots,
    },
    /**
     * Anyone on the roster who could go to IR right now. Starters are included —
     * placing one there clears their lineup slot, so there's no reason to make
     * the manager bench them first.
     */
    irCandidates: rostered
      .filter((p) => !p.on_ir && isIrEligible(p))
      .map((p) => p.id),
    /**
     * Projected, not scored. This used to sum `points`, which is what a player
     * has ALREADY scored — so before kickoff the "projected" total was always
     * zero, while the Acquisitions page showed real numbers because it looks
     * projections up separately.
     */
    projectedPoints:
      Math.round(starters.reduce((sum, s) => sum + (s.player?.projectedPoints ?? 0), 0) * 100) / 100,
  }
}

/**
 * Replace a team's starting lineup for the week.
 *
 * `assignments` is { [slotId]: playerId | null }. Any rostered player not named
 * lands on the bench and scores nothing.
 *
 * Locked players can't change position: a player who has already kicked off can
 * neither be benched nor started, and the slot they occupy is frozen.
 */
export async function setLineup(leagueId, teamId, season, week, assignments) {
  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'lineup', `${locks.phaseLabel} — lineups can't be changed right now.`)

  const [rosteredRows, currentRows] = await Promise.all([
    query(
      `SELECT p.* FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND rp.on_ir = 0`,
      { leagueId, teamId },
    ),
    query(
      `SELECT slot, player_id FROM lineups
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season AND week = @week`,
      { leagueId, teamId, season, week },
    ),
  ])

  const rostered = new Map(rosteredRows.map((p) => [p.id, p]))
  const current = new Map(currentRows.map((r) => [r.slot, r.player_id]))

  const next = new Map()
  const seen = new Set()

  for (const [slotId, playerId] of Object.entries(assignments)) {
    if (!SLOT_BY_ID.has(slotId)) throw httpError(`Unknown lineup slot "${slotId}".`)
    if (!playerId) {
      next.set(slotId, null)
      continue
    }
    const player = rostered.get(String(playerId))
    if (!player) throw httpError(`Player ${playerId} is not on this roster.`, 404)
    if (seen.has(player.id)) throw httpError(`${player.full_name} can't start in two slots.`)
    if (!canPlayerFillSlot(player, slotId)) {
      throw httpError(`${player.full_name} (${player.position}) isn't eligible for ${slotId}.`)
    }
    seen.add(player.id)
    next.set(slotId, player.id)
  }

  // Slots not mentioned keep whatever they had — unless that player was just
  // assigned somewhere else, in which case this is a move and the old slot
  // empties. Without this a partial update like { RB1: <player in RB2> } would
  // leave the player in both slots and double-count their points.
  for (const [slotId, playerId] of current) {
    if (next.has(slotId)) continue
    next.set(slotId, playerId && seen.has(playerId) ? null : playerId)
  }

  // Safety net: the final lineup must never start anyone twice.
  const placed = new Set()
  for (const playerId of next.values()) {
    if (!playerId) continue
    if (placed.has(playerId)) {
      throw httpError(`${rostered.get(playerId)?.full_name ?? playerId} can't start in two slots.`)
    }
    placed.add(playerId)
  }

  // Diff against the current lineup and reject any move involving a locked player.
  for (const slotConfig of rosterSlots) {
    const before = current.get(slotConfig.slot) ?? null
    const after = next.get(slotConfig.slot) ?? null
    if (before === after) continue

    for (const playerId of [before, after]) {
      if (!playerId) continue
      const player = rostered.get(playerId) || (await get('SELECT * FROM players WHERE id = @id', { id: playerId }))
      if (player) assertPlayerMovable(locks, player, 'move')
    }
  }

  await batch(
    rosterSlots.map((slotConfig) =>
      stmt(
        `INSERT INTO lineups (league_id, team_id, season, week, slot, player_id)
         VALUES (@leagueId, @teamId, @season, @week, @slot, @playerId)
         ON CONFLICT (league_id, team_id, season, week, slot)
         DO UPDATE SET player_id = excluded.player_id`,
        {
          leagueId,
          teamId,
          season,
          week,
          slot: slotConfig.slot,
          playerId: next.get(slotConfig.slot) ?? null,
        },
      ),
    ),
  )

  return getTeamRoster(leagueId, teamId, season, week, locks)
}

/** Ensure every configured slot has a row for the week (so the UI renders them). */
export function ensureLineupRows(leagueId, teamId, season, week) {
  return batch(
    rosterSlots.map((slot) =>
      stmt(
        `INSERT INTO lineups (league_id, team_id, season, week, slot, player_id)
         VALUES (@leagueId, @teamId, @season, @week, @slot, NULL)
         ON CONFLICT (league_id, team_id, season, week, slot) DO NOTHING`,
        { leagueId, teamId, season, week, slot: slot.slot },
      ),
    ),
  )
}

export async function getRosterCount(leagueId, teamId) {
  const row = await get(
    'SELECT COUNT(*) AS count FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId AND on_ir = 0',
    { leagueId, teamId },
  )
  return row.count
}

/**
 * Statements that move a player onto a roster, optionally dropping someone.
 *
 * Returns the list rather than executing, so the waiver processor can fold many
 * acquisitions into a single atomic batch. No lock or availability checks —
 * callers are responsible.
 */
export function acquisitionStatements({
  leagueId,
  teamId,
  season,
  week,
  addPlayerId,
  dropPlayerId = null,
  source = 'free_agent',
  notes = null,
  dropClearAt,
  toIr = false,
}) {
  const writes = []

  if (dropPlayerId) {
    writes.push(
      stmt('DELETE FROM roster_players WHERE league_id = @leagueId AND player_id = @playerId', {
        leagueId,
        playerId: dropPlayerId,
      }),
      stmt(
        `UPDATE lineups SET player_id = NULL
          WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
            AND week = @week AND player_id = @playerId`,
        { leagueId, teamId, season, week, playerId: dropPlayerId },
      ),
      poolStatements.placeOnWaivers(leagueId, dropPlayerId, dropClearAt),
      stmt(
        `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
         VALUES (@leagueId, @teamId, 'drop', @source, @playerId, @season, @week, @notes)`,
        { leagueId, teamId, source, playerId: dropPlayerId, season, week, notes },
      ),
    )
  }

  writes.push(
    stmt(
      `INSERT INTO roster_players (league_id, team_id, player_id, acquired_via, on_ir)
       VALUES (@leagueId, @teamId, @playerId, @source, @onIr)`,
      { leagueId, teamId, playerId: addPlayerId, source, onIr: toIr ? 1 : 0 },
    ),
    poolStatements.clearWaiverState(leagueId, addPlayerId),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_player_id, season, week, notes)
       VALUES (@leagueId, @teamId, 'add', @source, @playerId, @dropId, @season, @week, @notes)`,
      { leagueId, teamId, source, playerId: addPlayerId, dropId: dropPlayerId, season, week, notes },
    ),
  )

  return writes
}

/** Free-agent pickup, with every rule enforced. */
export async function addFreeAgent({
  leagueId,
  teamId,
  season,
  week,
  addPlayerId,
  dropPlayerId = null,
  toIr = false,
}) {
  const locks = await getLockState(leagueId)
  assertAllowed(
    locks,
    'freeAgentAdd',
    locks.phase === 'waiver_period'
      ? 'Free agency is closed during the waiver period — submit a waiver claim instead.'
      : `${locks.phaseLabel} — free agent moves are closed.`,
  )

  const target = await getPlayerWithAvailability(leagueId, addPlayerId)
  if (!target) throw httpError('Player not found.', 404)
  if (target.availability === AVAILABILITY.ROSTERED) {
    throw httpError(`${target.full_name} is already on ${target.owner_team_name}.`, 409)
  }
  if (target.availability === AVAILABILITY.WAIVERS) {
    throw httpError(`${target.full_name} is on waivers — submit a claim instead.`, 409, 'ON_WAIVERS')
  }
  assertPlayerMovable(locks, target, 'add')

  // Signing someone straight onto IR. They never occupy an active spot, so a
  // full roster is no obstacle — the only limit that applies is the IR slot.
  if (toIr) {
    if (!isIrEligible(target)) {
      throw httpError(
        `${target.full_name} doesn't qualify for IR (${target.injury_status || 'no injury designation'}).`,
        409,
        'NOT_IR_ELIGIBLE',
      )
    }
    if ((await getIrCount(leagueId, teamId)) >= rosterConfig.irSlots) {
      throw httpError(
        `Your ${rosterConfig.irSlots === 1 ? 'IR slot is' : 'IR slots are'} full.`,
        409,
        'IR_FULL',
      )
    }
  }

  if (dropPlayerId) {
    const dropping = await get(
      `SELECT p.* FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
      { leagueId, teamId, playerId: dropPlayerId },
    )
    if (!dropping) throw httpError('The player you want to drop is not on your roster.', 400)
    assertPlayerMovable(locks, dropping, 'drop')
  } else if (!toIr && (await getRosterCount(leagueId, teamId)) >= rosterConfig.maxPlayers) {
    throw httpError(
      `Your roster is full (${rosterConfig.maxPlayers}). Choose a player to drop.`,
      409,
      'ROSTER_FULL',
    )
  }

  const team = await get('SELECT name FROM teams WHERE id = @teamId', { teamId })
  const dropped = dropPlayerId
    ? await get('SELECT full_name FROM players WHERE id = @id', { id: dropPlayerId })
    : null

  await batch([
    ...acquisitionStatements({
      leagueId,
      teamId,
      season,
      week,
      addPlayerId,
      dropPlayerId,
      source: 'free_agent',
      dropClearAt: await nextWaiverClearTime(leagueId),
      toIr,
    }),
    systemMessageStatement({
      leagueId,
      teamId,
      eventType: toIr ? 'ir' : 'add',
      body:
        `${team?.name ?? 'A team'} signed ${target.full_name}` +
        (toIr ? ' straight to IR' : '') +
        (dropped ? `, dropping ${dropped.full_name}.` : '.'),
      meta: { addPlayerId, dropPlayerId, source: 'free_agent', toIr },
    }),
  ])

  return { addPlayerId, dropPlayerId, toIr }
}

/** Drop a player to waivers. */
export async function dropPlayer({ leagueId, teamId, season, week, playerId }) {
  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'drop', `${locks.phaseLabel} — drops are closed.`)

  const player = await get(
    `SELECT p.* FROM roster_players rp JOIN players p ON p.id = rp.player_id
      WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
    { leagueId, teamId, playerId },
  )
  if (!player) throw httpError('That player is not on your roster.', 404)
  assertPlayerMovable(locks, player, 'drop')

  const droppingTeam = await get('SELECT name FROM teams WHERE id = @teamId', { teamId })

  await batch([
    stmt('DELETE FROM roster_players WHERE league_id = @leagueId AND player_id = @playerId', {
      leagueId,
      playerId,
    }),
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
          AND week = @week AND player_id = @playerId`,
      { leagueId, teamId, season, week, playerId },
    ),
    poolStatements.placeOnWaivers(leagueId, playerId, await nextWaiverClearTime(leagueId)),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week)
       VALUES (@leagueId, @teamId, 'drop', 'free_agent', @playerId, @season, @week)`,
      { leagueId, teamId, playerId, season, week },
    ),
    systemMessageStatement({
      leagueId,
      teamId,
      eventType: 'drop',
      body: `${droppingTeam?.name ?? 'A team'} dropped ${player.full_name} to waivers.`,
      meta: { playerId },
    }),
  ])

  return { dropped: playerId }
}

// ---------------------------------------------------------------------------
// Injured reserve
// ---------------------------------------------------------------------------

/**
 * Is this injury designation severe enough for IR?
 *
 * Deliberately excludes Questionable: a player who might play on Sunday parked
 * on IR is just a free extra bench spot, which is what the slot limit exists to
 * prevent.
 */
export function isIrEligible(player) {
  const status = player?.injury_status ?? player?.injuryStatus ?? null
  if (!status) return false
  return rosterConfig.irEligibleStatuses.includes(status)
}

async function getIrCount(leagueId, teamId) {
  const row = await get(
    'SELECT COUNT(*) AS count FROM roster_players WHERE league_id = @leagueId AND team_id = @teamId AND on_ir = 1',
    { leagueId, teamId },
  )
  return row.count
}

/**
 * Move an injured player to IR.
 *
 * They stop counting against the roster limit, come out of the starting lineup,
 * and score nothing until activated.
 */
export async function placeOnIr({ leagueId, teamId, season, week, playerId }) {
  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'lineup', `${locks.phaseLabel} — roster moves are closed.`)

  const player = await get(
    `SELECT p.*, rp.on_ir FROM roster_players rp JOIN players p ON p.id = rp.player_id
      WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
    { leagueId, teamId, playerId },
  )
  if (!player) throw httpError('That player is not on your roster.', 404)
  if (player.on_ir) throw httpError(`${player.full_name} is already on injured reserve.`, 409)

  if (!isIrEligible(player)) {
    throw httpError(
      `${player.full_name} isn't eligible for IR. Only players listed as ` +
        `${rosterConfig.irEligibleStatuses.join(', ')} can be placed there.`,
      409,
      'IR_INELIGIBLE',
    )
  }

  if ((await getIrCount(leagueId, teamId)) >= rosterConfig.irSlots) {
    throw httpError(
      `Your ${rosterConfig.irSlots === 1 ? 'IR slot is' : 'IR slots are'} full. ` +
        'Activate or drop someone first.',
      409,
      'IR_FULL',
    )
  }

  assertPlayerMovable(locks, player, 'move to IR')

  await batch([
    stmt(
      `UPDATE roster_players SET on_ir = 1
        WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @playerId`,
      { leagueId, teamId, playerId },
    ),
    // An IR player can't be a starter.
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
          AND week = @week AND player_id = @playerId`,
      { leagueId, teamId, season, week, playerId },
    ),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
       VALUES (@leagueId, @teamId, 'ir', 'ir_place', @playerId, @season, @week, @notes)`,
      { leagueId, teamId, playerId, season, week, notes: `Placed on IR (${player.injury_status})` },
    ),
  ])

  return { playerId, onIr: true }
}

/** Bring a player back off IR, if there's room on the roster for them. */
export async function activateFromIr({ leagueId, teamId, season, week, playerId }) {
  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'lineup', `${locks.phaseLabel} — roster moves are closed.`)

  const player = await get(
    `SELECT p.*, rp.on_ir FROM roster_players rp JOIN players p ON p.id = rp.player_id
      WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
    { leagueId, teamId, playerId },
  )
  if (!player) throw httpError('That player is not on your roster.', 404)
  if (!player.on_ir) throw httpError(`${player.full_name} isn't on injured reserve.`, 409)

  // Activating puts them back on the roster proper, so there must be a spot.
  if ((await getRosterCount(leagueId, teamId)) >= rosterConfig.maxPlayers) {
    throw httpError(
      `Your roster is full (${rosterConfig.maxPlayers}). Drop someone before activating ` +
        `${player.full_name}.`,
      409,
      'ROSTER_FULL',
    )
  }

  await batch([
    stmt(
      `UPDATE roster_players SET on_ir = 0
        WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @playerId`,
      { leagueId, teamId, playerId },
    ),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, season, week, notes)
       VALUES (@leagueId, @teamId, 'ir', 'ir_activate', @playerId, @season, @week, 'Activated from IR')`,
      { leagueId, teamId, playerId, season, week },
    ),
  ])

  return { playerId, onIr: false }
}

/**
 * Swap one player off IR and another on, in a single operation.
 *
 * Without this a full roster plus a full IR is a deadlock: activating needs an
 * open roster spot, and the only way to make one is to drop somebody — so a
 * second injury costs you a player purely for bookkeeping reasons. Because the
 * two moves net out, the roster count never changes and no drop is needed.
 */
export async function swapIr({ leagueId, teamId, season, week, activatePlayerId, placePlayerId }) {
  const locks = await getLockState(leagueId)
  assertAllowed(locks, 'lineup', `${locks.phaseLabel} — roster moves are closed.`)

  const [leaving, arriving] = await Promise.all([
    get(
      `SELECT p.*, rp.on_ir FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
      { leagueId, teamId, playerId: activatePlayerId },
    ),
    get(
      `SELECT p.*, rp.on_ir FROM roster_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND p.id = @playerId`,
      { leagueId, teamId, playerId: placePlayerId },
    ),
  ])

  if (!leaving) throw httpError('The player you want to activate is not on your roster.', 404)
  if (!arriving) throw httpError('The player you want to move to IR is not on your roster.', 404)
  if (!leaving.on_ir) throw httpError(`${leaving.full_name} isn't on injured reserve.`, 409)
  if (arriving.on_ir) throw httpError(`${arriving.full_name} is already on injured reserve.`, 409)

  if (!isIrEligible(arriving)) {
    throw httpError(
      `${arriving.full_name} isn't eligible for IR. Only players listed as ` +
        `${rosterConfig.irEligibleStatuses.join(', ')} can be placed there.`,
      409,
      'IR_INELIGIBLE',
    )
  }

  // The arriving player is coming off the active roster, so they must be movable
  // — you can't shelve someone whose game is already under way.
  assertPlayerMovable(locks, arriving, 'move to IR')

  await batch([
    stmt(
      `UPDATE roster_players SET on_ir = 0
        WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @activateId`,
      { leagueId, teamId, activateId: activatePlayerId },
    ),
    stmt(
      `UPDATE roster_players SET on_ir = 1
        WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @placeId`,
      { leagueId, teamId, placeId: placePlayerId },
    ),
    // An IR player can't be a starter.
    stmt(
      `UPDATE lineups SET player_id = NULL
        WHERE league_id = @leagueId AND team_id = @teamId AND season = @season
          AND week = @week AND player_id = @placeId`,
      { leagueId, teamId, season, week, placeId: placePlayerId },
    ),
    stmt(
      `INSERT INTO transactions (league_id, team_id, type, source, player_id, related_player_id, season, week, notes)
       VALUES (@leagueId, @teamId, 'ir', 'ir_swap', @placeId, @activateId, @season, @week, @notes)`,
      {
        leagueId,
        teamId,
        placeId: placePlayerId,
        activateId: activatePlayerId,
        season,
        week,
        notes: `IR swap: ${arriving.full_name} in (${arriving.injury_status}), ${leaving.full_name} out`,
      },
    ),
  ])

  return { activated: activatePlayerId, placed: placePlayerId }
}
