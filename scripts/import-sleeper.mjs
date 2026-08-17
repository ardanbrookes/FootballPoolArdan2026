#!/usr/bin/env node
/**
 * Import a drafted Sleeper league.
 *
 *   npm run import:sleeper -- --league 123456789012345678
 *       Preview only. Writes nothing. Read the report before committing.
 *
 *   npm run import:sleeper -- --league 123456789012345678 --commit
 *       REPLACES every roster in the league with the Sleeper rosters.
 *
 * Options:
 *   --league <id>     Sleeper league id (from the URL: sleeper.com/leagues/<id>)
 *   --commit          actually write (default is a dry run)
 *   --team-names      also adopt the team names people set on Sleeper
 *   --local           target the local dev worker instead of production
 *   --map a=1,b=2     force Sleeper user id -> our team id for unmatched managers
 *
 * Requires ADMIN_TOKEN in the environment (or WORKER_URL to override the target).
 */

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const sleeperLeagueId = value('league')
if (!sleeperLeagueId) {
  console.error('Missing --league <sleeper league id>. It is in your Sleeper league URL.')
  process.exit(1)
}

const token = process.env.ADMIN_TOKEN
if (!token) {
  console.error('Set ADMIN_TOKEN in the environment first.')
  process.exit(1)
}

const base =
  process.env.WORKER_URL ||
  (flag('local') ? 'http://localhost:8787' : 'https://football-pool-2026.ardanbrookes.workers.dev')

const managerMap = {}
if (value('map')) {
  for (const pair of value('map').split(',')) {
    const [userId, teamId] = pair.split('=')
    if (userId && teamId) managerMap[userId.trim()] = Number(teamId.trim())
  }
}

const commit = flag('commit')

const res = await fetch(`${base}/api/admin/import/sleeper`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-token': token },
  body: JSON.stringify({
    sleeperLeagueId,
    commit,
    importTeamNames: flag('team-names'),
    managerMap,
  }),
})

const report = await res.json()
if (!res.ok) {
  console.error(`\nFailed (${res.status}): ${report.error || JSON.stringify(report)}`)
  process.exit(1)
}

const pad = (s, n) => String(s).padEnd(n)

console.log('')
console.log(commit ? '=== IMPORT COMMITTED ===' : '=== DRY RUN — nothing written ===')
console.log('')
console.log('Sleeper league :', report.sleeperLeague.name, `(${report.sleeperLeague.season})`)
console.log('Draft picks    :', report.sleeperLeague.picks)
console.log('')

console.log('Settings comparison:')
for (const [key, cmp] of Object.entries(report.settingsComparison)) {
  const agree = String(cmp.sleeper) === String(cmp.ours)
  console.log(`  ${agree ? 'ok  ' : 'DIFF'} ${pad(key, 16)} sleeper=${pad(cmp.sleeper, 8)} ours=${cmp.ours}`)
}

console.log('')
console.log(`Managers matched: ${report.matchedManagers}`)
for (const t of report.teams) {
  console.log(
    `  ${pad(t.teamName, 22)} <- ${pad(t.sleeperManager, 14)} ` +
      `${t.players} players (${t.active} active, ${t.onIr} IR) via ${t.matchedVia}, lineup by ${t.lineupMethod}`,
  )
}

if (report.unmatchedManagers.length) {
  console.log('')
  console.log('UNMATCHED Sleeper managers — pass --map to place them:')
  for (const u of report.unmatchedManagers) console.log(`  ${u.userId}  ${u.displayName}`)
  console.log('Available teams:')
  for (const t of report.unclaimedTeams) console.log(`  ${t.id}  ${t.name}`)
}

if (report.warnings.length) {
  console.log('')
  console.log('Warnings:')
  for (const w of report.warnings) console.log(`  - ${w}`)
}

console.log('')
if (commit) {
  console.log(`Done. ${report.poolResetToWaivers} undrafted players placed on waivers.`)
} else {
  console.log('Looks right? Re-run with --commit to apply it.')
}
