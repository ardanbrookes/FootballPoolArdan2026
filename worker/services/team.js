/**
 * Team self-service: naming your team, and listing players you'll trade.
 */

import { get, query, run, batch, stmt, nowIso } from '../db.js'
import { systemMessageStatement, postSystemMessage } from './chat.js'

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

const MAX_NAME = 32
const MAX_ABBR = 5

/**
 * Rename a team.
 *
 * Allowed at any time, in any phase — a team name has no bearing on scoring,
 * locks or waivers, so there is nothing to protect it from. The abbreviation is
 * derived unless one is given, because it shows up in scoreboards where the
 * full name won't fit.
 */
export async function renameTeam({ leagueId, teamId, name, abbreviation = null }) {
  const trimmed = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) throw httpError('A team name is required.')
  if (trimmed.length > MAX_NAME) throw httpError(`Team names are limited to ${MAX_NAME} characters.`)

  const team = await get('SELECT id, name, abbreviation FROM teams WHERE id = @teamId AND league_id = @leagueId', {
    teamId,
    leagueId,
  })
  if (!team) throw httpError('Team not found.', 404)

  const clash = await get(
    'SELECT id FROM teams WHERE league_id = @leagueId AND id != @teamId AND lower(name) = lower(@name)',
    { leagueId, teamId, name: trimmed },
  )
  if (clash) throw httpError(`Another team is already called "${trimmed}".`, 409)

  // Initials of the first three words, falling back to the first letters.
  const derived =
    trimmed
      .split(' ')
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 4) || trimmed.slice(0, 3).toUpperCase()

  const abbr = String(abbreviation ?? derived).trim().toUpperCase().slice(0, MAX_ABBR) || derived

  const abbrClash = await get(
    'SELECT id FROM teams WHERE league_id = @leagueId AND id != @teamId AND upper(abbreviation) = @abbr',
    { leagueId, teamId, abbr },
  )
  // An abbreviation collision is not worth blocking a rename over, so fall back
  // to something unique rather than refusing.
  const finalAbbr = abbrClash ? `${abbr.slice(0, MAX_ABBR - 1)}${teamId}`.slice(0, MAX_ABBR) : abbr

  if (trimmed === team.name && finalAbbr === team.abbreviation) {
    return { id: teamId, name: trimmed, abbreviation: finalAbbr, changed: false }
  }

  await run(
    'UPDATE teams SET name = @name, abbreviation = @abbr WHERE id = @teamId AND league_id = @leagueId',
    { name: trimmed, abbr: finalAbbr, teamId, leagueId },
  )

  if (trimmed !== team.name) {
    await postSystemMessage({
      leagueId,
      teamId,
      eventType: 'rename',
      body: `${team.name} is now ${trimmed}.`,
      meta: { from: team.name, to: trimmed },
    })
  }

  return { id: teamId, name: trimmed, abbreviation: finalAbbr, changed: true }
}

/**
 * Put a player on, or take them off, the trade block.
 *
 * Announced in chat, because the entire point is that other managers find out —
 * a listing nobody sees is the same as no listing. Removing one is silent: the
 * league does not need a notification every time somebody changes their mind.
 */
export async function setTradeBlock({ leagueId, teamId, playerId, listed }) {
  const row = await get(
    `SELECT rp.on_trade_block, p.full_name, p.position, p.nfl_team, t.name AS team_name
       FROM roster_players rp
       JOIN players p ON p.id = rp.player_id
       JOIN teams t ON t.id = rp.team_id
      WHERE rp.league_id = @leagueId AND rp.team_id = @teamId AND rp.player_id = @playerId`,
    { leagueId, teamId, playerId },
  )
  if (!row) throw httpError('That player is not on your roster.', 404)

  const next = listed ? 1 : 0
  if (Boolean(row.on_trade_block) === Boolean(next)) {
    return { playerId, listed: Boolean(next), changed: false }
  }

  const writes = [
    stmt(
      `UPDATE roster_players SET on_trade_block = @next, trade_block_at = @at
        WHERE league_id = @leagueId AND team_id = @teamId AND player_id = @playerId`,
      { next, at: next ? nowIso() : null, leagueId, teamId, playerId },
    ),
  ]

  if (next) {
    writes.push(
      systemMessageStatement({
        leagueId,
        teamId,
        eventType: 'trade_block',
        body: `${row.team_name} is open to trading ${row.full_name} (${row.position}${
          row.nfl_team ? `, ${row.nfl_team}` : ''
        }).`,
        meta: { playerId, teamId },
      }),
    )
  }

  await batch(writes)
  return { playerId, listed: Boolean(next), changed: true }
}

/** Everyone currently listed, newest first. */
export async function getTradeBlock(leagueId) {
  const rows = await query(
    `SELECT rp.player_id, rp.trade_block_at, rp.team_id,
            t.name AS team_name, t.abbreviation AS team_abbr,
            p.full_name, p.position, p.nfl_team, p.injury_status, p.bye_week
       FROM roster_players rp
       JOIN teams t ON t.id = rp.team_id
       JOIN players p ON p.id = rp.player_id
      WHERE rp.league_id = @leagueId AND rp.on_trade_block = 1
      ORDER BY rp.trade_block_at DESC`,
    { leagueId },
  )

  return rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    teamAbbr: r.team_abbr,
    listedAt: r.trade_block_at,
    player: {
      id: r.player_id,
      name: r.full_name,
      position: r.position,
      nflTeam: r.nfl_team,
      injuryStatus: r.injury_status,
      byeWeek: r.bye_week,
    },
  }))
}
