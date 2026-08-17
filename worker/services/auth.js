/**
 * Local authentication.
 *
 * Deliberately minimal — this is a league of friends, not a bank.
 *
 * Passwords use PBKDF2-HMAC-SHA256 via WebCrypto rather than scrypt: workerd
 * doesn't implement `crypto.scrypt`, and WebCrypto is available everywhere
 * Workers run. Sessions are opaque random tokens, stored hashed, handed out as
 * httpOnly cookies.
 */

import { get, query, run, nowIso } from '../db.js'
import { getServerConfig } from '../config.js'

const PBKDF2_ITERATIONS = 100_000
const KEY_BITS = 256
export const SESSION_COOKIE = 'ffpool_session'

const encoder = new TextEncoder()

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function hashPassword(password, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return { hash: toHex(bits), salt }
}

/** Constant-time string compare — avoids leaking the hash via response timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(password, hash, salt) {
  const candidate = await hashPassword(password, salt)
  return timingSafeEqual(candidate.hash, hash)
}

async function hashToken(token) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(getServerConfig().sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(token)))
}

export async function createUser({ username, displayName, password, email = null, isCommissioner = false }) {
  const { hash, salt } = await hashPassword(password)
  const result = await run(
    `INSERT INTO users (username, display_name, email, password_hash, password_salt, is_commissioner)
     VALUES (@username, @displayName, @email, @hash, @salt, @isCommissioner)`,
    {
      username: username.toLowerCase().trim(),
      displayName,
      email,
      hash,
      salt,
      isCommissioner: isCommissioner ? 1 : 0,
    },
  )
  return get('SELECT id, username, display_name, is_commissioner FROM users WHERE id = @id', {
    id: result.lastInsertRowid,
  })
}

export async function authenticate(username, password) {
  const user = await get('SELECT * FROM users WHERE username = @username', {
    username: String(username || '').toLowerCase().trim(),
  })
  if (!user) return null
  if (!(await verifyPassword(password, user.password_hash, user.password_salt))) return null
  return user
}

export async function createSession(userId) {
  const { sessionTtlDays } = getServerConfig()
  const token = randomHex(32)
  const expiresAt = new Date(Date.now() + sessionTtlDays * 86_400_000).toISOString()
  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (@tokenHash, @userId, @expiresAt)', {
    tokenHash: await hashToken(token),
    userId,
    expiresAt,
  })
  return { token, expiresAt }
}

export async function resolveSession(token) {
  if (!token) return null
  const session = await get(
    `SELECT s.user_id, s.expires_at, u.id, u.username, u.display_name, u.is_commissioner
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = @tokenHash`,
    { tokenHash: await hashToken(token) },
  )
  if (!session) return null
  if (session.expires_at <= nowIso()) {
    await destroySession(token)
    return null
  }
  return {
    id: session.id,
    username: session.username,
    displayName: session.display_name,
    isCommissioner: Boolean(session.is_commissioner),
  }
}

export async function destroySession(token) {
  if (!token) return
  await run('DELETE FROM sessions WHERE token_hash = @tokenHash', { tokenHash: await hashToken(token) })
}

export function purgeExpiredSessions() {
  return run('DELETE FROM sessions WHERE expires_at <= @now', { now: nowIso() })
}

/** The teams a user manages, across leagues. */
export function getUserTeams(userId) {
  return query(
    `SELECT t.id, t.league_id, t.name, t.abbreviation, t.logo_url, l.name AS league_name,
            l.season, l.current_week
       FROM teams t JOIN leagues l ON l.id = t.league_id
      WHERE t.user_id = @userId
      ORDER BY l.season DESC, t.name ASC`,
    { userId },
  )
}
