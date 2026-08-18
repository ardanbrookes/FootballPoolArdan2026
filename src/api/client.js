/**
 * Thin fetch wrapper.
 * Cookies carry the session, so every call sends credentials.
 */

const BASE = '/api'

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const isJson = res.headers.get('content-type')?.includes('application/json')
  const payload = isJson ? await res.json() : null

  if (!res.ok) {
    const error = new Error(payload?.error || `Request failed (${res.status})`)
    error.status = res.status
    error.code = payload?.code
    throw error
  }

  return payload
}

const qs = (params = {}) => {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString()
  return search ? `?${search}` : ''
}

export const api = {
  // Auth
  me: () => request('GET', '/auth/me'),
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout'),

  // League
  overview: () => request('GET', '/league'),
  lockState: () => request('GET', '/league/lock-state'),
  standings: () => request('GET', '/league/standings'),
  matchups: (week) => request('GET', `/league/matchups${qs({ week })}`),
  matchupDetail: (week, teamId) => request('GET', `/league/matchup${qs({ week, teamId })}`),
  leagueSchedule: () => request('GET', '/league/schedule'),
  leagueOverview: (week) => request('GET', `/league/overview${qs({ week })}`),
  playoffs: () => request('GET', '/league/playoffs'),
  nflGames: (week) => request('GET', `/league/nfl-games${qs({ week })}`),
  rosters: (week) => request('GET', `/league/rosters${qs({ week })}`),
  transactions: (limit) => request('GET', `/league/transactions${qs({ limit })}`),
  waiverOrder: () => request('GET', '/league/waiver-order'),

  // My team
  roster: (week, teamId) => request('GET', `/league/roster${qs({ week, teamId })}`),
  setLineup: (assignments, week) => request('PUT', '/league/lineup', { assignments, week }),
  addFreeAgent: (addPlayerId, dropPlayerId) =>
    request('POST', '/league/free-agents/add', { addPlayerId, dropPlayerId }),
  dropPlayer: (playerId) => request('POST', '/league/drop', { playerId }),
  placeOnIr: (playerId) => request('POST', '/league/ir/place', { playerId }),
  activateFromIr: (playerId) => request('POST', '/league/ir/activate', { playerId }),
  swapIr: (activatePlayerId, placePlayerId) =>
    request('POST', '/league/ir/swap', { activatePlayerId, placePlayerId }),

  // Players
  searchPlayers: (params) => request('GET', `/league/players${qs(params)}`),
  setWatchlist: (playerId, watched) => request('POST', '/league/watchlist', { playerId, watched }),

  // News
  news: (params) => request('GET', `/league/news${qs(params)}`),

  // Chat
  chat: (before) => request('GET', `/league/chat${qs({ before })}`),
  postChat: (body) => request('POST', '/league/chat', { body }),

  // Waivers
  claims: (mine = true) => request('GET', `/league/waivers/claims${qs({ mine: mine ? 1 : 0 })}`),
  submitClaim: (addPlayerId, dropPlayerId) =>
    request('POST', '/league/waivers/claims', { addPlayerId, dropPlayerId }),
  cancelClaim: (claimId) => request('DELETE', `/league/waivers/claims/${claimId}`),
  reorderClaims: (claimIds) => request('PUT', '/league/waivers/claims/order', { claimIds }),
  waiverResults: (params) => request('GET', `/league/waivers/results${qs(params)}`),
  waiverPreview: () => request('GET', '/league/waivers/preview'),
  processWaivers: () => request('POST', '/league/waivers/process'),

  // Trades
  trades: (params) => request('GET', `/league/trades${qs(params)}`),
  proposeTrade: (payload) => request('POST', '/league/trades', payload),
  respondToTrade: (tradeId, accept, message) =>
    request('POST', `/league/trades/${tradeId}/respond`, { accept, message }),
  cancelTrade: (tradeId) => request('POST', `/league/trades/${tradeId}/cancel`),
}

export default api
