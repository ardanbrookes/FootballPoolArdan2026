/**
 * Convenience wrapper for the admin endpoints.
 *
 * Workers have no CLI process that can hold a D1 binding, so operational tasks
 * (seeding, forcing a waiver run) are HTTP endpoints guarded by ADMIN_TOKEN.
 * This just saves typing the curl.
 *
 *   node scripts/admin.mjs seed --force
 *   node scripts/admin.mjs tick
 *   node scripts/admin.mjs waivers/process
 *   node scripts/admin.mjs status --remote
 *
 * Local runs read ADMIN_TOKEN from .dev.vars; --remote needs ADMIN_TOKEN and
 * WORKER_URL in the environment.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const endpoint = args.find((a) => !a.startsWith('-'))
const remote = args.includes('--remote')
const force = args.includes('--force')
const job = args.find((a) => a.startsWith('--job='))?.split('=')[1]

if (!endpoint) {
  console.error('Usage: node scripts/admin.mjs <endpoint> [--force] [--remote] [--job=name]')
  console.error('Endpoints: seed, tick, status, waivers/process, week-reset, stats-refresh,')
  console.error('           sync/players, sync/schedule, sync/daily')
  process.exit(1)
}

/** Read a key from .dev.vars without pulling in a dotenv dependency. */
function readDevVar(key) {
  const file = path.join(ROOT, '.dev.vars')
  if (!fs.existsSync(file)) return null
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, '')
  }
  return null
}

const token = process.env.ADMIN_TOKEN || (remote ? null : readDevVar('ADMIN_TOKEN'))
if (!token) {
  console.error(
    remote
      ? 'Set ADMIN_TOKEN in the environment for --remote runs.'
      : 'No ADMIN_TOKEN found. Copy .dev.vars.example to .dev.vars.',
  )
  process.exit(1)
}

const base = remote
  ? process.env.WORKER_URL || (console.error('Set WORKER_URL for --remote runs.'), process.exit(1))
  : process.env.WORKER_URL || 'http://localhost:8787'

const params = new URLSearchParams()
if (force) params.set('force', '1')
if (job) params.set('job', job)

const method = endpoint === 'status' ? 'GET' : 'POST'
const url = `${base}/api/admin/${endpoint}${params.toString() ? `?${params}` : ''}`

console.log(`${method} ${url}`)

const res = await fetch(url, { method, headers: { 'x-admin-token': token } })
const text = await res.text()

let payload
try {
  payload = JSON.parse(text)
} catch {
  console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
  process.exit(1)
}

if (payload.logs) {
  for (const line of payload.logs) console.log(line)
  delete payload.logs
}

console.log(JSON.stringify(payload, null, 2))
process.exit(res.ok ? 0 : 1)
