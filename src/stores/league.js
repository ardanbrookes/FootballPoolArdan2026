import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/client.js'

/** Session: who's signed in and which team they manage. */
export const useSessionStore = defineStore('session', () => {
  const user = ref(null)
  const teams = ref([])
  const ready = ref(false)

  const isSignedIn = computed(() => Boolean(user.value))
  const myTeam = computed(() => teams.value[0] ?? null)

  async function load() {
    try {
      const data = await api.me()
      user.value = data.user
      teams.value = data.teams || []
    } catch {
      user.value = null
      teams.value = []
    } finally {
      ready.value = true
    }
  }

  async function login(username, password) {
    const data = await api.login(username, password)
    user.value = data.user
    teams.value = data.teams || []
    return data
  }

  async function logout() {
    await api.logout()
    user.value = null
    teams.value = []
  }

  return { user, teams, ready, isSignedIn, myTeam, load, login, logout }
})

/** League state shared across views: config, lock phase, standings. */
export const useLeagueStore = defineStore('league', () => {
  const league = ref(null)
  const config = ref(null)
  const lockState = ref(null)
  const standings = ref([])
  const myTeam = ref(null)
  const loading = ref(false)
  const error = ref(null)

  const currentWeek = computed(() => league.value?.currentWeek ?? 1)
  const phase = computed(() => lockState.value?.phase ?? null)
  const allows = computed(() => lockState.value?.allows ?? {})
  const rosterSlots = computed(() => config.value?.rosterSlots ?? [])

  async function load() {
    loading.value = true
    error.value = null
    try {
      const data = await api.overview()
      league.value = data.league
      config.value = data.config
      lockState.value = data.lockState
      standings.value = data.standings || []
      myTeam.value = data.myTeam
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  /** Cheap poll used after any transaction, so lock banners stay honest. */
  async function refreshLocks() {
    try {
      lockState.value = await api.lockState()
    } catch {
      /* non-fatal */
    }
  }

  return {
    league,
    config,
    lockState,
    standings,
    myTeam,
    loading,
    error,
    currentWeek,
    phase,
    allows,
    rosterSlots,
    load,
    refreshLocks,
  }
})
