/**
 * League chat and event feed.
 *
 * People's messages and the league's own events share one table, so the home
 * page renders a single chronological stream: someone gloating about a waiver
 * claim appears directly under the claim itself.
 *
 * System posts are written at the moment the thing happens rather than derived
 * on read. That costs a row per event but means the feed is a genuine log — it
 * can't be rewritten by a later standings recalculation or a schedule change.
 */

import { get, query, run, stmt } from '../db.js'

const MAX_BODY = 1000

function httpError(message, status = 400, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

/** Recent messages, oldest last so the client can render bottom-up. */
export async function listMessages(leagueId, { limit = 60, before = null } = {}) {
  const rows = await query(
    `SELECT m.id, m.kind, m.event_type, m.body, m.meta_json, m.created_at,
            u.display_name AS author, t.abbreviation AS team_abbr, t.name AS team_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.league_id = @leagueId
        ${before ? 'AND m.created_at < @before' : ''}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT @limit`,
    before ? { leagueId, before, limit } : { leagueId, limit: Math.min(limit, 200) },
  )

  return rows
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      eventType: row.event_type,
      body: row.body,
      author: row.author,
      teamAbbr: row.team_abbr,
      teamName: row.team_name,
      createdAt: row.created_at,
      meta: (() => {
        try {
          return row.meta_json ? JSON.parse(row.meta_json) : null
        } catch {
          return null
        }
      })(),
    }))
    .reverse()
}

/** Post a chat message as a signed-in manager. */
export async function postMessage({ leagueId, userId, teamId = null, body }) {
  const text = String(body ?? '').trim()
  if (!text) throw httpError('Message cannot be empty.')
  if (text.length > MAX_BODY) throw httpError(`Keep it under ${MAX_BODY} characters.`)

  const result = await run(
    `INSERT INTO messages (league_id, user_id, team_id, kind, body)
     VALUES (@leagueId, @userId, @teamId, 'chat', @body)`,
    { leagueId, userId, teamId, body: text },
  )

  return get(
    `SELECT m.id, m.kind, m.event_type, m.body, m.meta_json, m.created_at,
            u.display_name AS author, t.abbreviation AS team_abbr
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.id = @id`,
    { id: result.lastInsertRowid },
  )
}

/**
 * Statement form of a system post, so callers can fold it into an existing
 * batch rather than issuing a separate write mid-transaction.
 */
export function systemMessageStatement({ leagueId, teamId = null, eventType, body, meta = null }) {
  return stmt(
    `INSERT INTO messages (league_id, team_id, kind, event_type, body, meta_json)
     VALUES (@leagueId, @teamId, 'system', @eventType, @body, @meta)`,
    { leagueId, teamId, eventType, body, meta: meta ? JSON.stringify(meta) : null },
  )
}

/** Fire-and-forget system post, for callers not already batching. */
export async function postSystemMessage({ leagueId, teamId = null, eventType, body, meta = null }) {
  return run(
    `INSERT INTO messages (league_id, team_id, kind, event_type, body, meta_json)
     VALUES (@leagueId, @teamId, 'system', @eventType, @body, @meta)`,
    { leagueId, teamId, eventType, body, meta: meta ? JSON.stringify(meta) : null },
  )
}

/**
 * Announce a phase change, but only when it actually changes.
 *
 * The tick runs every 15 minutes; without the guard the feed would fill with
 * "still the open window" every quarter hour.
 */
export async function announcePhaseChange(leagueId, phase, phaseLabel, deadline) {
  const last = await get(
    `SELECT body, meta_json FROM messages
      WHERE league_id = @leagueId AND kind = 'system' AND event_type = 'phase'
      ORDER BY created_at DESC LIMIT 1`,
    { leagueId },
  )

  let lastPhase = null
  try {
    lastPhase = last?.meta_json ? JSON.parse(last.meta_json).phase : null
  } catch {
    lastPhase = null
  }
  if (lastPhase === phase) return { posted: false }

  const blurb = {
    blanket_lock: 'Rosters are locked and trades are closed. Free agents have moved to waivers.',
    waiver_period: 'Rosters are unlocked and trades are open. Waiver claims process Tuesday 3:00 AM.',
    open: 'Waivers have cleared. Free agents are first come, first served.',
    early_game_lock: 'Thursday night is under way — only the two teams playing are locked.',
  }

  await postSystemMessage({
    leagueId,
    eventType: 'phase',
    body: `${phaseLabel}. ${blurb[phase] ?? ''}`.trim(),
    meta: { phase, deadline: deadline ?? null },
  })

  return { posted: true, phase }
}
