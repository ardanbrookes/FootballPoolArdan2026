/**
 * Per-league runtime settings.
 *
 * Defaults come from config.js (Worker vars). A commissioner can override the
 * timing values without a redeploy; overrides live in `league_settings` and are
 * merged on top of the defaults here.
 */

import { query, run } from '../db.js'
import {
  getTimingConfig,
  waivers as defaultWaivers,
  rosterSlots,
  roster,
  playoffs,
  scoring,
} from '../config.js'

const TIMING_KEYS = ['timezone', 'waiverProcess', 'weekReset', 'blanketLock']

export async function getOverrides(leagueId) {
  const rows = await query('SELECT key, value_json FROM league_settings WHERE league_id = @leagueId', {
    leagueId,
  })
  const out = {}
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value_json)
    } catch {
      // Ignore malformed rows rather than taking down every request.
    }
  }
  return out
}

/** Effective timing config for a league: defaults + stored overrides. */
export async function getTiming(leagueId) {
  const overrides = await getOverrides(leagueId)
  const merged = { ...getTimingConfig() }
  for (const key of TIMING_KEYS) {
    const value = overrides[`timing.${key}`]
    if (value === undefined || value === null) continue
    merged[key] = typeof value === 'object' ? { ...merged[key], ...value } : value
  }
  return merged
}

export async function getWaiverConfig(leagueId) {
  const overrides = await getOverrides(leagueId)
  return { ...defaultWaivers, ...(overrides.waivers || {}) }
}

export async function setSetting(leagueId, key, value) {
  await run(
    `INSERT INTO league_settings (league_id, key, value_json, updated_at)
     VALUES (@leagueId, @key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (league_id, key)
     DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    { leagueId, key, value: JSON.stringify(value) },
  )
}

/** Everything the client needs to render deadlines and lineup slots. */
export async function getPublicConfig(leagueId) {
  const [timing, waiverConfig] = await Promise.all([getTiming(leagueId), getWaiverConfig(leagueId)])
  return {
    timing,
    waivers: waiverConfig,
    rosterSlots,
    benchSize: roster.benchSize,
    maxPlayers: roster.maxPlayers,
    starterCount: rosterSlots.length,
    irSlots: roster.irSlots,
    irEligibleStatuses: roster.irEligibleStatuses,
    playoffs,
    // Sent so the rules page renders the table the scoring engine actually uses,
    // rather than a hand-maintained copy that can drift.
    scoring,
  }
}
