/**
 * Session middleware for Hono.
 *
 * `attachUser` is permissive — it populates c.get('user') when a valid cookie is
 * present and moves on otherwise. `requireUser` / `requireTeam` are the gates.
 */

import { getCookie } from 'hono/cookie'
import { get } from '../db.js'
import { resolveSession, SESSION_COOKIE } from '../services/auth.js'
import { getServerConfig } from '../config.js'

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Which league is this request about?
 *
 * An explicit id always wins. Otherwise prefer a league the signed-in user
 * actually plays in, then fall back to the only/first league. Resolving rather
 * than hardcoding id 1 keeps the single-league routes working after a reseed,
 * where AUTOINCREMENT hands out a fresh id.
 */
async function resolveLeagueId(c) {
  const explicit = c.req.param('leagueId') ?? c.req.query('leagueId') ?? c.get('body')?.leagueId
  if (explicit !== undefined && explicit !== null && explicit !== '') return Number(explicit)

  const user = c.get('user')
  if (user) {
    const mine = await get('SELECT league_id FROM teams WHERE user_id = @userId ORDER BY id ASC LIMIT 1', {
      userId: user.id,
    })
    if (mine) return mine.league_id
  }

  const first = await get('SELECT id FROM leagues ORDER BY id ASC LIMIT 1')
  return first?.id ?? null
}

export async function attachUser(c, next) {
  c.set('user', await resolveSession(getCookie(c, SESSION_COOKIE)))
  await next()
}

/** Caches the parsed JSON body so multiple middleware can read it. */
export async function parseBody(c, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    try {
      c.set('body', await c.req.json())
    } catch {
      c.set('body', {})
    }
  }
  await next()
}

export async function requireUser(c, next) {
  if (!c.get('user')) throw httpError('Sign in to continue.', 401)
  await next()
}

/** Loads the league (resolving the default) onto c.get('league'). */
export async function loadLeague(c, next) {
  const leagueId = await resolveLeagueId(c)
  if (leagueId == null) throw httpError('No league has been created yet.', 404)

  const league = await get('SELECT * FROM leagues WHERE id = @leagueId', { leagueId })
  if (!league) throw httpError('League not found.', 404)

  c.set('league', league)
  await next()
}

/**
 * Resolves c.get('team') for the league in play and asserts the signed-in user
 * manages it. Commissioners may act on any team by passing ?teamId=.
 */
export async function requireTeam(c, next) {
  const user = c.get('user')
  if (!user) throw httpError('Sign in to continue.', 401)

  const league = c.get('league')
  const requestedTeamId = c.req.param('teamId') ?? c.req.query('teamId') ?? c.get('body')?.teamId

  const team = requestedTeamId
    ? await get('SELECT * FROM teams WHERE id = @teamId AND league_id = @leagueId', {
        teamId: Number(requestedTeamId),
        leagueId: league.id,
      })
    : await get('SELECT * FROM teams WHERE user_id = @userId AND league_id = @leagueId', {
        userId: user.id,
        leagueId: league.id,
      })

  if (!team) throw httpError('No team found for you in this league.', 404)
  if (team.user_id !== user.id && !user.isCommissioner) throw httpError("That's not your team.", 403)

  c.set('team', team)
  await next()
}

export async function requireCommissioner(c, next) {
  if (!c.get('user')?.isCommissioner) throw httpError('Commissioner only.', 403)
  await next()
}

/**
 * Token-only gate, for things that must work before any user exists (seeding)
 * or that can destroy the league.
 */
export async function requireAdminToken(c, next) {
  const { adminToken } = getServerConfig()
  if (!adminToken) throw httpError('ADMIN_TOKEN is not configured.', 503)

  const provided = c.req.header('x-admin-token')
  if (provided !== adminToken) throw httpError('Invalid admin token.', 401)
  await next()
}

/**
 * Gate for routine operations: forcing a waiver run, resyncing players, etc.
 *
 * Accepts either the admin token or a signed-in commissioner. The commissioner
 * path is what you'll actually use — it means running these from the app,
 * without keeping a token to hand.
 */
export async function requireAdminOrCommissioner(c, next) {
  const { adminToken } = getServerConfig()
  const provided = c.req.header('x-admin-token')

  if (adminToken && provided === adminToken) return next()
  if (c.get('user')?.isCommissioner) return next()

  throw httpError('Commissioner sign-in or a valid admin token is required.', 401)
}
