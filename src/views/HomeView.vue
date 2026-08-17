<script setup>
/**
 * Home: this week at a glance — the live head-to-head scoreboard, your full
 * roster, league chat, last week's results, and the countdown to whatever locks
 * next. Standings live on the League page; duplicating them here added nothing.
 */
import { ref, computed, onMounted } from 'vue'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'
import DeadlineTimer from '@/components/DeadlineTimer.vue'
import LineupEditor from '@/components/LineupEditor.vue'
import MatchupCard from '@/components/MatchupCard.vue'
import MatchupScoreboard from '@/components/MatchupScoreboard.vue'
import ChatBox from '@/components/ChatBox.vue'
import { formatKickoff } from '@/utils/time.js'

const league = useLeagueStore()

const roster = ref(null)
const matchupDetail = ref(null)
const lastWeek = ref([])
const nflGames = ref([])
const loading = ref(true)
const saving = ref(false)
const message = ref(null)
const error = ref(null)

const myTeamId = computed(() => league.myTeam?.id ?? null)
const lastWeekNumber = computed(() => league.currentWeek - 1)

/** The games that trigger the Thursday-night lock, for the "what locks when" list. */
const earlyGames = computed(() => {
  const blanket = league.lockState?.cycle?.blanketLockAt
  if (!blanket) return []
  return nflGames.value.filter((g) => g.kickoff_at < blanket)
})

const lockedTeams = computed(() => new Set(league.lockState?.lockedNflTeams || []))

async function loadAll() {
  loading.value = true
  error.value = null
  try {
    const week = league.currentWeek
    const [rosterData, matchupData, gamesData] = await Promise.all([
      api.roster(week),
      api.matchupDetail(week),
      api.nflGames(league.lockState?.activeWeek ?? week),
    ])
    roster.value = rosterData.roster
    matchupDetail.value = matchupData.matchup
    nflGames.value = gamesData.games

    if (week > 1) {
      const previous = await api.matchups(week - 1)
      lastWeek.value = previous.matchups
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function saveLineup(assignments, reset) {
  saving.value = true
  message.value = null
  error.value = null
  try {
    const data = await api.setLineup(assignments, league.currentWeek)
    roster.value = data.roster
    league.lockState = data.lockState
    reset()
    message.value = 'Lineup saved.'
    setTimeout(() => (message.value = null), 3000)
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
  }
}

/**
 * IR moves change roster shape rather than the week's lineup, so they apply
 * immediately through their own endpoints instead of waiting for a lineup save.
 */
const irBusy = ref(false)

async function irAction(apiCall, player, describe) {
  irBusy.value = true
  message.value = null
  error.value = null
  try {
    const data = await apiCall(player.id)
    roster.value = data.roster
    message.value = describe
    setTimeout(() => (message.value = null), 3000)
  } catch (err) {
    error.value = err.message
  } finally {
    irBusy.value = false
  }
}

const moveToIr = (player) =>
  irAction(api.placeOnIr, player, `${player.name} moved to injured reserve.`)
const activateFromIr = (player) =>
  irAction(api.activateFromIr, player, `${player.name} activated from IR.`)

const kickoffLabel = (iso) => formatKickoff(iso, league.config?.timing?.timezone)

onMounted(loadAll)
</script>

<template>
  <div class="stack">
    <div v-if="message" class="alert alert-success">{{ message }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <!-- The countdown carries the phase on its own; the full explainer banner
         lives on Acquisitions, where the phase actually changes what you can do. -->
    <div class="card">
      <div class="card-body deadline-bar">
        <DeadlineTimer :deadline="league.lockState?.nextDeadline" @elapsed="league.refreshLocks()" />
        <span class="phase-tag tiny">{{ league.lockState?.phaseLabel }}</span>
      </div>
    </div>

    <MatchupScoreboard v-if="matchupDetail" :matchup="matchupDetail" :my-team-id="myTeamId" />
    <div v-else-if="loading" class="card"><div class="empty">Loading matchup…</div></div>
    <div v-else class="card"><div class="empty">No matchup scheduled this week.</div></div>

    <div class="grid grid-2">
      <LineupEditor
        v-if="roster"
        :roster="roster"
        :can-edit="league.allows.lineup"
        :saving="saving"
        :ir-busy="irBusy"
        @save="saveLineup"
        @ir-place="moveToIr"
        @ir-activate="activateFromIr"
      />
      <div v-else-if="loading" class="card"><div class="empty">Loading roster…</div></div>

      <div class="stack">
        <ChatBox />

        <div class="card">
          <div class="card-header"><h2>Locks this week</h2></div>
          <div class="card-body">
            <ul v-if="earlyGames.length" class="lock-list">
              <li v-for="game in earlyGames" :key="game.id">
                <span :class="{ 'pill pill-warn': lockedTeams.has(game.away_team) }">{{ game.away_team }}</span>
                <span class="faint">@</span>
                <span :class="{ 'pill pill-warn': lockedTeams.has(game.home_team) }">{{ game.home_team }}</span>
                <span class="tiny faint">{{ kickoffLabel(game.kickoff_at) }}</span>
              </li>
            </ul>
            <p v-else class="small faint" style="margin: 0">
              No early games — everything locks at the Sunday blanket lock.
            </p>
          </div>
        </div>

      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Last week's results</h2>
        <span v-if="lastWeek.length" class="tiny faint">Week {{ lastWeekNumber }}</span>
      </div>
      <div class="card-body">
        <div v-if="lastWeek.length" class="grid grid-2">
          <MatchupCard
            v-for="matchup in lastWeek"
            :key="matchup.id"
            :matchup="matchup"
            :my-team-id="myTeamId"
          />
        </div>
        <div v-else class="empty">
          {{ league.currentWeek <= 1 ? "The season hasn't started yet." : 'No results for last week.' }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.deadline-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.phase-tag {
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  white-space: nowrap;
}

.lock-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.lock-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  font-family: var(--mono);
}

.lock-list li :last-child {
  margin-left: auto;
}
</style>
