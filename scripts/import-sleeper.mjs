#!/usr/bin/env node
/**
 * Import a drafted Sleeper league.
 *
 * Draft night, in order:
 *
 *   1. npm run import:sleeper -- --user <your-sleeper-username>
 *        Finds your league id. No token needed. Do this once, any time.
 *
 *   2. npm run import:sleeper -- --league <id>
 *        Dry run. Writes NOTHING. Check every manager matched.
 *
 *   3. npm run import:sleeper -- --league <id> --commit --team-names
 *        Applies it. REPLACES every roster in the league.
 *
 * Options:
 *   --user <name>     look up a Sleeper account's leagues and exit
 *   --season <yyyy>   season for --user (default: current year)
 *   --league <id>     Sleeper league id
 *   --commit          actually write (default is a dry run)
 *   --team-names      also adopt the team names people set on Sleeper
 *   --local           target the local dev worker instead of production
 *   --map Blake=1,... force a Sleeper manager onto one of our teams. The key can
 *                     be their Sleeper display name, username, or user id.
 *
 * --user needs nothing. Everything else needs ADMIN_TOKEN in the environment.
 *
 * NOTE: this script never calls process.exit(). Node on Windows aborts with a
 * libuv assertion if the process is torn down while fetch's sockets are still
 * open, which looks like a crash right after a successful import. Setting
 * process.exitCode and returning lets it wind down cleanly instead.
 */

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const pad = (s, n) => String(s ?? '').padEnd(n)
const SLEEPER = 'https://api.sleeper.app/v1'

const fail = (...lines) => {
  for (const line of lines) console.error(line)
  process.exitCode = 1
}

/**
 * League discovery.
 *
 * The league id lives in the Sleeper web URL, which is no help at all if you
 * only ever use the phone app — which is how the first attempt at this ended in
 * a 404. Looking it up from a username removes the guesswork.
 */
async function lookupUser(username, season) {
  const user = await (await fetch(`${SLEEPER}/user/${encodeURIComponent(username)}`))
    .json()
    .catch(() => null)

  // Sleeper answers an unknown username with 200 and a literal null, so a
  // status check alone would sail straight past a typo.
  if (!user || !user.user_id) {
    return fail(
      `\nNo Sleeper account called "${username}".`,
      'Use the username you log in with, not your display name or team name.',
    )
  }

  const leagues =
    (await (await fetch(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${season}`)).json()) || []

  console.log('')
  console.log(`Sleeper account : ${user.display_name} (@${user.username || username})`)
  console.log(`Season          : ${season}`)
  console.log('')

  if (!leagues.length) {
    console.log(`No ${season} leagues on this account.`)
    console.log('If you drafted in a different season, re-run with --season <year>.')
    return
  }

  console.log('Leagues:')
  console.log('  ' + pad('league id', 22) + pad('teams', 7) + pad('status', 12) + 'name')
  for (const l of leagues) {
    console.log('  ' + pad(l.league_id, 22) + pad(l.total_rosters, 7) + pad(l.status, 12) + l.name)
  }
  console.log('')
  console.log('Next, dry-run the one you want:')
  console.log(`  npm run import:sleeper -- --league ${leagues[0].league_id}`)
}

async function runImport(sleeperLeagueId) {
  const token = process.env.ADMIN_TOKEN
  if (!token) {
    return fail(
      'ADMIN_TOKEN is not set in this shell.',
      '',
      'PowerShell:',
      '  $env:ADMIN_TOKEN = "your-token-here"',
      '',
      'It only lasts for the current window, so set it again in a new one.',
    )
  }

  const base =
    process.env.WORKER_URL ||
    (flag('local') ? 'http://localhost:8787' : 'https://football-pool-2026.ardanbrookes.workers.dev')

  const managerMap = {}
  if (value('map')) {
    for (const pair of value('map').split(',')) {
      const [userId, teamId] = pair.split('=')
      // The key may be a Sleeper user id, username or display name. Names are
      // lowercased because that is how the importer compares them.
      if (userId && teamId) managerMap[userId.trim().toLowerCase()] = Number(teamId.trim())
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

  const report = await res.json().catch(() => ({}))
  if (!res.ok) {
    const extra = []
    if (res.status === 404) {
      extra.push(
        '',
        'That league id does not exist on Sleeper. Find the right one with:',
        '  npm run import:sleeper -- --user <your-sleeper-username>',
      )
    }
    if (res.status === 401) {
      extra.push(
        '',
        'ADMIN_TOKEN was rejected. Cloudflare secrets are write-only — if it is',
        'lost, set a new one with: npx wrangler secret put ADMIN_TOKEN',
      )
    }
    return fail(`\nFailed (${res.status}): ${report.error || JSON.stringify(report)}`, ...extra)
  }

  console.log('')
  console.log(commit ? '=== IMPORT COMMITTED ===' : '=== DRY RUN — nothing written ===')
  console.log('')
  console.log('Sleeper league :', report.sleeperLeague.name, `(${report.sleeperLeague.season})`)
  console.log('Draft picks    :', report.sleeperLeague.picks)
  console.log('')

  console.log('Settings comparison:')
  let settingsDiffer = false
  for (const [key, cmp] of Object.entries(report.settingsComparison)) {
    const agree = String(cmp.sleeper) === String(cmp.ours)
    if (!agree) settingsDiffer = true
    console.log(
      `  ${agree ? 'ok  ' : 'DIFF'} ${pad(key, 16)} sleeper=${pad(cmp.sleeper, 8)} ours=${cmp.ours}`,
    )
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
    console.log('UNMATCHED Sleeper managers — nothing would be imported for these:')
    for (const u of report.unmatchedManagers) console.log(`  ${u.userId}  ${u.displayName}`)
    if (report.unclaimedTeams.length) {
      console.log('Teams still free:')
      for (const t of report.unclaimedTeams) console.log(`  ${t.id}  ${t.name}`)
    } else {
      console.log('')
      console.log(
        `No free teams left — the Sleeper league has ${report.matchedManagers + report.unmatchedManagers.length} ` +
          `managers but this league only has ${report.matchedManagers}. Nothing can be imported for the rest.`,
      )
    }
    // Emit the whole mapping pre-paired in listed order, so it only needs the
    // pairs corrected rather than typed from scratch.
    const pairs = report.unmatchedManagers
      .map((u, i) => {
        const team = report.unclaimedTeams[i]
        return team ? `${u.displayName}=${team.id}` : null
      })
      .filter(Boolean)
    if (pairs.length) {
      console.log('')
      console.log('Paste this and fix the pairings, then dry-run again:')
      console.log('')
      console.log(`  npm run import:sleeper -- --league ${sleeperLeagueId} --map ${pairs.join(',')}`)
      console.log('')
      console.log('Better: set each manager\'s display name to their Sleeper name once, and')
      console.log('matching becomes automatic — npm run managers -- --template')
    }
  }

  if (report.missingPlayerIds?.length) {
    console.log('')
    console.log(
      `${report.missingPlayerIds.length} drafted player(s) are not in our player table and ` +
        'would be skipped. Refresh the player list, then dry-run again:',
    )
    console.log(`  ${report.missingPlayerIds.slice(0, 10).join(', ')}`)
  }

  if (report.warnings.length) {
    console.log('')
    console.log('Warnings:')
    for (const w of report.warnings) console.log(`  - ${w}`)
  }

  console.log('')
  if (commit) {
    // Undrafted players are FREE AGENTS after an import, not waivers — a league
    // that has just drafted is in the open window. Saying "waivers" here would
    // have everyone waiting until Tuesday to sign anyone.
    console.log(`Done. ${report.poolResetToWaivers} undrafted players are now FREE AGENTS`)
    console.log('(first come, first served until the first Sunday lock).')
    console.log('')
    console.log('Now open the site and check the League tab shows every roster.')
    return
  }

  if (report.unmatchedManagers.length) {
    console.log('NOT READY — some managers are unmatched. Fix with --map, then dry-run again.')
    return
  }
  if (settingsDiffer) {
    console.log('Ready to commit, but the settings above differ from Sleeper.')
    console.log('Our rules win — the import only moves players, never scoring.')
  } else {
    console.log('Looks good. Apply it with:')
  }
  console.log('')
  console.log(`  npm run import:sleeper -- --league ${sleeperLeagueId} --commit --team-names`)
}

async function main() {
  if (value('user')) {
    return lookupUser(value('user'), value('season') || String(new Date().getFullYear()))
  }

  const sleeperLeagueId = value('league')
  if (!sleeperLeagueId) {
    return fail(
      'Missing --league <sleeper league id>.',
      '',
      "Don't know it? Look it up from your Sleeper username:",
      '  npm run import:sleeper -- --user <your-sleeper-username>',
    )
  }

  return runImport(sleeperLeagueId)
}

await main()
