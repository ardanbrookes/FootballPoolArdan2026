/**
 * Request-scoped context.
 *
 * Workers hand `env` (bindings, vars, secrets) to the fetch/scheduled handler
 * rather than exposing it globally the way `process.env` works in Node. Rather
 * than thread `env` through every function signature, we stash it — and the D1
 * binding — in AsyncLocalStorage for the life of the request.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

/** Run `fn` with `env` (and its D1 binding) as ambient context. */
export function withContext(env, fn) {
  return storage.run({ env, db: env.DB }, fn)
}

export function getStore() {
  const store = storage.getStore()
  if (!store) {
    throw new Error('No request context — wrap the call in withContext(env, ...)')
  }
  return store
}

export function getEnv() {
  return getStore().env
}

export function getDb() {
  const { db } = getStore()
  if (!db) throw new Error('No D1 binding named DB. Check wrangler.toml.')
  return db
}
