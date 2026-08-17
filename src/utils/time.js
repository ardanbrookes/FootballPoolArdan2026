/**
 * Deadline formatting.
 *
 * League rules are written in the league's timezone ("waivers run Tuesday 3am"),
 * so deadlines must render in that zone regardless of where the manager is
 * sitting. Formatting in the viewer's local zone silently turns "3:00 AM" into
 * whatever their offset makes it, which is exactly the kind of thing that gets
 * someone's lineup locked by surprise.
 */

export function formatInZone(iso, timeZone, options = {}) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.valueOf())) return '—'

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...options,
    timeZone,
  }).format(date)
}

/** Short form for dense lists — no timezone suffix. */
export function formatShort(iso, timeZone) {
  return formatInZone(iso, timeZone, { timeZoneName: undefined })
}

/** Weekday + time, for kickoff lists. */
export function formatKickoff(iso, timeZone) {
  return formatInZone(iso, timeZone, {
    weekday: 'short',
    month: undefined,
    day: undefined,
    timeZoneName: undefined,
  })
}
