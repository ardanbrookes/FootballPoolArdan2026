/**
 * D1 access.
 *
 * Two things to know before editing anything that writes:
 *
 * 1. D1 is async. Every helper here returns a promise, and every caller awaits.
 * 2. D1 has no interactive transactions — you cannot BEGIN, read, decide, and
 *    COMMIT across awaits. The only atomic primitive is `batch()`, which runs a
 *    prepared list of statements in one go. So mutating flows decide everything
 *    in memory first, collect statements, and submit them together via `batch`.
 *
 * The binding is carried in AsyncLocalStorage rather than passed through every
 * signature, which keeps the service layer readable.
 */

import { getDb } from './context.js'

const conn = getDb

/**
 * D1 binds parameters positionally (?), but the codebase uses @named params for
 * readability. This rewrites a named-parameter statement into positional form.
 *
 * Repeated names are supported: each occurrence binds again, in order.
 */
export function toPositional(sql, params = {}) {
  const values = []
  const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    if (!(name in params)) {
      throw new Error(`Missing bind parameter "${name}" for statement: ${sql.slice(0, 120)}`)
    }
    values.push(normalize(params[name]))
    return '?'
  })
  return { text, values }
}

/** D1 accepts null, number, string, ArrayBuffer and boolean-as-number only. */
function normalize(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

/** Build a D1 prepared statement without running it — for use with `batch`. */
export function stmt(sql, params = {}) {
  const { text, values } = toPositional(sql, params)
  return conn().prepare(text).bind(...values)
}

/** All rows of a SELECT. */
export async function query(sql, params = {}) {
  const { results } = await stmt(sql, params).all()
  return results ?? []
}

/** First row of a SELECT, or undefined. */
export async function get(sql, params = {}) {
  const row = await stmt(sql, params).first()
  return row ?? undefined
}

/** A single write. Returns { changes, lastInsertRowid }. */
export async function run(sql, params = {}) {
  const result = await stmt(sql, params).run()
  return {
    changes: result.meta?.changes ?? 0,
    lastInsertRowid: result.meta?.last_row_id ?? null,
  }
}

/**
 * Run a list of statements atomically.
 *
 * Accepts either prepared statements from `stmt()` or [sql, params] pairs.
 * Empty lists are a no-op so callers don't need to guard.
 */
/**
 * D1 batches are bounded — a few thousand statements in one call will fail or
 * take the Worker down. Anything larger is split into chunks.
 *
 * The trade-off is that a chunked batch is no longer one atomic transaction, so
 * reserve very large batches for bulk operations that are safe to re-run (the
 * pool reset, the Sleeper import) rather than for anything a user is waiting on
 * mid-transaction.
 */
const MAX_BATCH_STATEMENTS = 100

export async function batch(statements) {
  const prepared = statements
    .filter(Boolean)
    .map((entry) => (Array.isArray(entry) ? stmt(entry[0], entry[1]) : entry))
  if (prepared.length === 0) return []

  if (prepared.length <= MAX_BATCH_STATEMENTS) return conn().batch(prepared)

  const results = []
  for (let i = 0; i < prepared.length; i += MAX_BATCH_STATEMENTS) {
    const chunk = prepared.slice(i, i + MAX_BATCH_STATEMENTS)
    results.push(...(await conn().batch(chunk)))
  }
  return results
}

/**
 * Collects statements so a multi-step operation can be submitted as one batch.
 *
 * Usage:
 *   const writes = new WriteSet()
 *   writes.add('UPDATE ...', { id })
 *   await writes.commit()
 */
export class WriteSet {
  constructor() {
    this.statements = []
  }

  add(sql, params = {}) {
    this.statements.push(stmt(sql, params))
    return this
  }

  get size() {
    return this.statements.length
  }

  commit() {
    return batch(this.statements)
  }
}

/** Current time as an ISO-8601 UTC string — the format every timestamp column uses. */
export function nowIso() {
  return new Date().toISOString()
}
