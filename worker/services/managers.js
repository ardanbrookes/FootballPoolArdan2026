/**
 * Manager setup: who owns which team, what they log in with, what it's called.
 *
 * This exists because of one discovery from rehearsing the Sleeper import: the
 * importer matches managers by DISPLAY NAME first, then team name, then
 * username. A freshly seeded league has placeholder names, so a real Sleeper
 * league matches nobody and every roster has to be mapped by hand.
 *
 * Setting each manager's display name to the name they use on Sleeper turns
 * that into an automatic 8-of-8 match, which is the whole point.
 */

import { get, query, run, batch, stmt } from '../db.js'
import { hashPassword } from './auth.js'

/** Everything the setup file needs, and nothing secret. */
export async function listManagers(leagueId) {
  const rows = await query(
    `SELECT t.id AS team_id, t.name AS team_name, t.abbreviation,
            u.id AS user_id, u.username, u.display_name, u.is_commissioner
       FROM teams t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.league_id = @leagueId
      ORDER BY t.id`,
    { leagueId },
  )
  return rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    abbreviation: r.abbreviation,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    isCommissioner: Boolean(r.is_commissioner),
  }))
}

function invalid(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

/**
 * Apply a list of manager updates.
 *
 * Every field is optional per entry, so this can be used to rename teams
 * without touching logins, or to reset one person's password without touching
 * anything else. `dryRun` reports exactly what would change.
 *
 * Passwords are never echoed back — the caller already knows what it sent, and
 * anything returned here ends up in a terminal scrollback.
 */
export async function applyManagers(leagueId, entries, { dryRun = true } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw invalid('No manager entries supplied.')

  const current = await listManagers(leagueId)
  const byTeam = new Map(current.map((m) => [m.teamId, m]))

  // Usernames are the login key and must stay unique across the whole app.
  const takenUsernames = new Map(
    (await query('SELECT id, username FROM users')).map((u) => [u.username, u.id]),
  )

  const changes = []
  const writes = []
  const seenTeams = new Set()
  const seenUsernames = new Set()

  for (const entry of entries) {
    const teamId = Number(entry.teamId)
    const team = byTeam.get(teamId)
    if (!team) throw invalid(`No team with id ${entry.teamId} in this league.`)
    if (seenTeams.has(teamId)) throw invalid(`Team ${teamId} appears twice in the file.`)
    seenTeams.add(teamId)

    const change = { teamId, teamName: team.teamName, updates: [] }

    if (entry.teamName && entry.teamName !== team.teamName) {
      change.updates.push({ field: 'teamName', from: team.teamName, to: entry.teamName })
      writes.push(
        stmt('UPDATE teams SET name = @name WHERE id = @teamId AND league_id = @leagueId', {
          name: entry.teamName,
          teamId,
          leagueId,
        }),
      )
    }

    if (entry.abbreviation && entry.abbreviation !== team.abbreviation) {
      change.updates.push({ field: 'abbreviation', from: team.abbreviation, to: entry.abbreviation })
      writes.push(
        stmt('UPDATE teams SET abbreviation = @abbr WHERE id = @teamId AND league_id = @leagueId', {
          abbr: entry.abbreviation,
          teamId,
          leagueId,
        }),
      )
    }

    if (!team.userId) {
      // A team with no user can't be logged into; renaming it is still fine.
      if (entry.username || entry.displayName || entry.password) {
        throw invalid(`Team ${teamId} (${team.teamName}) has no manager account attached.`)
      }
      if (change.updates.length) changes.push(change)
      continue
    }

    if (entry.username) {
      const username = String(entry.username).toLowerCase().trim()
      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        throw invalid(`"${entry.username}" is not a usable username (a-z, 0-9, . _ - only).`)
      }
      const owner = takenUsernames.get(username)
      if (owner != null && owner !== team.userId) {
        throw invalid(`Username "${username}" already belongs to someone else.`)
      }
      if (seenUsernames.has(username)) throw invalid(`Username "${username}" appears twice in the file.`)
      seenUsernames.add(username)

      if (username !== team.username) {
        change.updates.push({ field: 'username', from: team.username, to: username })
        writes.push(
          stmt('UPDATE users SET username = @username WHERE id = @userId', {
            username,
            userId: team.userId,
          }),
        )
      }
    }

    // The field the Sleeper importer matches on first.
    if (entry.displayName && entry.displayName !== team.displayName) {
      change.updates.push({ field: 'displayName', from: team.displayName, to: entry.displayName })
      writes.push(
        stmt('UPDATE users SET display_name = @displayName WHERE id = @userId', {
          displayName: entry.displayName,
          userId: team.userId,
        }),
      )
    }

    if (entry.password) {
      if (String(entry.password).length < 4) {
        throw invalid(`Password for team ${teamId} is too short.`)
      }
      change.updates.push({ field: 'password', from: '••••', to: '••••' })
      if (!dryRun) {
        const { hash, salt } = await hashPassword(String(entry.password))
        writes.push(
          stmt(
            'UPDATE users SET password_hash = @hash, password_salt = @salt WHERE id = @userId',
            { hash, salt, userId: team.userId },
          ),
        )
      }
    }

    if (change.updates.length) changes.push(change)
  }

  if (!dryRun && writes.length) {
    await batch(writes)
    // Changing a password should end any session already signed in as them.
    const reset = entries.filter((e) => e.password).map((e) => Number(e.teamId))
    for (const teamId of reset) {
      const team = byTeam.get(teamId)
      if (team?.userId) {
        await run('DELETE FROM sessions WHERE user_id = @userId', { userId: team.userId })
      }
    }
  }

  return {
    dryRun,
    teamsChanged: changes.length,
    changes,
    managers: await listManagers(leagueId),
  }
}
