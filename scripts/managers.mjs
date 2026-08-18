#!/usr/bin/env node
/**
 * Set up the eight managers: logins, display names and team names.
 *
 * Do this BEFORE the draft. The Sleeper importer matches managers by display
 * name first, so setting each person's display name to the name they use on
 * Sleeper is what turns draft night into a single command instead of eight
 * hand-written id mappings.
 *
 *   npm run managers -- --list
 *       Show the current setup.
 *
 *   npm run managers -- --template
 *       Write managers.json pre-filled with what's there now. Edit it.
 *
 *   npm run managers -- --apply
 *       Dry run: show exactly what would change.
 *
 *   npm run managers -- --apply --commit
 *       Apply it.
 *
 * Options:
 *   --file <path>   which file to read/write (default: managers.json)
 *   --local         target the local dev worker instead of production
 *
 * Needs ADMIN_TOKEN in the environment.
 *
 * managers.json holds real passwords, so it is gitignored. Keep it somewhere
 * safe or delete it once everyone has signed in.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const pad = (s, n) => String(s ?? '').padEnd(n)
const file = value('file') || 'managers.json'

const fail = (...lines) => {
  for (const line of lines) console.error(line)
  process.exitCode = 1
}

const base =
  process.env.WORKER_URL ||
  (flag('local') ? 'http://localhost:8787' : 'https://football-pool-2026.ardanbrookes.workers.dev')

async function api(path, options = {}) {
  const token = process.env.ADMIN_TOKEN
  if (!token) {
    throw new Error(
      'ADMIN_TOKEN is not set in this shell.\n\nPowerShell:\n  $env:ADMIN_TOKEN = "your-token-here"',
    )
  }
  const res = await fetch(`${base}/api/admin/${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': token,
      ...(options.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status}: ${body.error || JSON.stringify(body)}`)
  return body
}

function printManagers(managers) {
  console.log('')
  console.log(
    '  ' + pad('team', 5) + pad('team name', 24) + pad('login', 14) + pad('display name', 20) + 'role',
  )
  console.log('  ' + '-'.repeat(72))
  for (const m of managers) {
    console.log(
      '  ' +
        pad(m.teamId, 5) +
        pad(m.teamName, 24) +
        pad(m.username || '(none)', 14) +
        pad(m.displayName || '(none)', 20) +
        (m.isCommissioner ? 'commissioner' : ''),
    )
  }
}

async function main() {
  if (flag('list')) {
    const { managers } = await api('managers')
    printManagers(managers)
    console.log('')
    console.log('The display name column is what the Sleeper import matches on.')
    return
  }

  if (flag('template')) {
    const { managers } = await api('managers')
    if (existsSync(file) && !flag('force')) {
      return fail(`${file} already exists. Delete it, or pass --force to overwrite.`)
    }
    const template = {
      _readme: [
        'Set displayName to the name each person uses on SLEEPER — that is what the',
        'import matches on. username is what they type to log in here. password is',
        'optional: leave it out to keep the current one.',
        'Then: npm run managers -- --apply    (add --commit to actually write)',
      ],
      managers: managers.map((m) => ({
        teamId: m.teamId,
        teamName: m.teamName,
        username: m.username || '',
        displayName: m.displayName || '',
        password: '',
      })),
    }
    writeFileSync(file, JSON.stringify(template, null, 2))
    console.log(`\nWrote ${file} with ${managers.length} teams.`)
    console.log('Edit it, then run:  npm run managers -- --apply')
    return
  }

  if (flag('apply')) {
    if (!existsSync(file)) {
      return fail(`${file} not found. Create it first:`, '  npm run managers -- --template')
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const entries = (parsed.managers || []).map((m) => {
      const entry = { teamId: m.teamId }
      // Empty strings mean "leave alone" — otherwise a half-filled template
      // would blank out names that are already correct.
      for (const key of ['teamName', 'abbreviation', 'username', 'displayName', 'password']) {
        if (m[key]) entry[key] = m[key]
      }
      return entry
    })

    const commit = flag('commit')
    const report = await api('managers', {
      method: 'POST',
      body: JSON.stringify({ managers: entries, commit }),
    })

    console.log('')
    console.log(commit ? '=== APPLIED ===' : '=== DRY RUN — nothing written ===')
    if (!report.changes.length) {
      console.log('\nNothing to change; the site already matches the file.')
    } else {
      for (const change of report.changes) {
        console.log(`\n  team ${change.teamId} (${change.teamName})`)
        for (const u of change.updates) {
          console.log(`    ${pad(u.field, 14)} ${pad(u.from, 20)} ->  ${u.to}`)
        }
      }
    }

    printManagers(report.managers)
    console.log('')
    if (commit) {
      console.log('Done. Anyone whose password changed has been signed out.')
      console.log('')
      console.log('Next: dry-run the Sleeper import and confirm all managers match:')
      console.log('  npm run import:sleeper -- --user <your-sleeper-username>')
    } else {
      console.log('Apply it with:  npm run managers -- --apply --commit')
    }
    return
  }

  console.log('Usage:')
  console.log('  npm run managers -- --list                 show the current setup')
  console.log('  npm run managers -- --template             write managers.json to edit')
  console.log('  npm run managers -- --apply                dry run')
  console.log('  npm run managers -- --apply --commit       apply it')
  console.log('')
  console.log('Add --local to target the local dev worker.')
}

try {
  await main()
} catch (err) {
  fail(`\n${err.message}`)
}
