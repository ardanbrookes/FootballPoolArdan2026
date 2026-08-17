/**
 * League clock.
 *
 * Every deadline is derived here from the configurable `timing` block, in the
 * league's timezone, so DST never shifts a deadline by an hour. Nothing else in
 * the codebase should do weekday math.
 *
 * Pure date arithmetic — no database, so these stay synchronous.
 */

import { DateTime } from 'luxon'
import { getTimingConfig } from '../config.js'

export function now(zone) {
  return DateTime.now().setZone(zone || getTimingConfig().timezone)
}

export function fromIso(iso, zone) {
  return DateTime.fromISO(iso, { zone: zone || getTimingConfig().timezone })
}

/** The most recent occurrence of a weekly {weekday, hour, minute}, at or before `ref`. */
export function mostRecent(spec, ref, zone) {
  const base = ref.setZone(zone).set({
    weekday: spec.weekday,
    hour: spec.hour,
    minute: spec.minute,
    second: 0,
    millisecond: 0,
  })
  return base > ref ? base.minus({ weeks: 1 }) : base
}

/** The next occurrence of a weekly {weekday, hour, minute}, strictly after `ref`. */
export function nextAfter(spec, ref, zone) {
  const base = ref.setZone(zone).set({
    weekday: spec.weekday,
    hour: spec.hour,
    minute: spec.minute,
    second: 0,
    millisecond: 0,
  })
  return base <= ref ? base.plus({ weeks: 1 }) : base
}

/**
 * The boundaries of the fantasy week containing `ref`.
 *
 * Anchored on the Sunday 1pm lock, because that's the only boundary that is a
 * fixed clock time — everything else follows from it:
 *
 *   blanketLockAt      Sun 13:00, start of this cycle
 *   weekResetAt        when the week's last game ends (Monday night)
 *   waiverProcessAt    Tue 03:00
 *   nextBlanketLockAt  Sun 13:00 again
 *
 * `lastGameEndsAt` is passed in rather than looked up here, so this module stays
 * pure date arithmetic with no database dependency. Callers that know the
 * schedule (services/locks.js) supply it; without it the configured fallback
 * time is used.
 */
export function getCycle(ref, config, { lastGameEndsAt = null } = {}) {
  const timing = config || getTimingConfig()
  const zone = timing.timezone
  const at = (ref || now(zone)).setZone(zone)

  const blanketLockAt = mostRecent(timing.blanketLock, at, zone)
  const nextBlanketLockAt = blanketLockAt.plus({ weeks: 1 })

  const useSchedule = timing.weekReset?.mode !== 'fixed' && lastGameEndsAt
  const weekResetAt = useSchedule
    ? lastGameEndsAt.setZone(zone)
    : nextAfter(timing.weekReset.fallback, blanketLockAt, zone)

  const waiverProcessAt = nextAfter(timing.waiverProcess, blanketLockAt, zone)

  return {
    zone,
    blanketLockAt,
    weekResetAt,
    waiverProcessAt,
    nextBlanketLockAt,
    /** True when the reset came from real kickoff times rather than the fallback. */
    weekResetFromSchedule: Boolean(useSchedule),
  }
}

/** Human-friendly label, e.g. "Tue, Sep 8 at 3:00 AM EDT". */
export function label(dt) {
  return dt.toFormat("ccc, LLL d 'at' h:mm a ZZZZ")
}

export function toIso(dt) {
  return dt.toUTC().toISO()
}
