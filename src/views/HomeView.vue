<script setup>
/**
 * Home: this week at a glance — the live head-to-head scoreboard, your full
 * roster, league chat, last week's results, and the countdown to whatever locks
 * next. Standings live on the League page; duplicating them here added nothing.
 */
import { ref, computed, onMounted } from 'vue'
import { useLive } from '@/composables/useLive.js'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'
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

/**
 * Games that kick off before Sunday's lock — the ones that lock their teams
 * early — for the "what locks when" list.
 *
 * Measured against the NEXT Sunday lock. The cycle's own blanketLockAt is the
 * Sunday just gone, so filtering against it left this list empty in every
 * phase, even with teams already locked.
 */
const earlyGames = computed(() => {
  const nextLock = league.lockState?.cycle?.nextBlanketLockAt
  if (!nextLock) return []
  return nflGames.value.filter((g) => g.kickoff_at < nextLock)
})

const lockedTeams = computed(() => new Set(league.lockState?.lockedNflTeams || []))

/** `quiet` skips the loading state, so a background poll doesn't flash the UI. */
async function loadAll({ quiet = false } = {}) {
  if (!quiet) loading.value = true
  if (!quiet) error.value = null
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
    if (!quiet) error.value = err.message
    else throw err
  } finally {
    if (!quiet) loading.value = false
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

/** One call, both moves — see swapIr on the server for why this exists. */
async function swapIr({ activate, place }) {
  irBusy.value = true
  message.value = null
  error.value = null
  try {
    const data = await api.swapIr(activate.id, place.id)
    roster.value = data.roster
    message.value = `${place.name} to IR, ${activate.name} back on your bench.`
    setTimeout(() => (message.value = null), 4000)
  } catch (err) {
    error.value = err.message
  } finally {
    irBusy.value = false
  }
}

/** Set while the lineup has unsaved edits, so background polls hold off. */
const lineupDirty = ref(false)

const kickoffLabel = (iso) => formatKickoff(iso, league.config?.timing?.timezone)

/**
 * Put the block that matters right now at the top.
 *
 * The week has three moods, and the lock phases map onto them:
 *
 *   waiver_period    Monday night to Tuesday 3am — the week just ended, so you
 *                    want to see how it went. Results first, matchup last.
 *   open             Tuesday until the week's first kickoff — the week is being
 *                    built. Roster first, matchup next, results last.
 *   game period      First kickoff to Monday's final whistle, through both the
 *                    partial lock (early_game_lock) and the full lock
 *                    (blanket_lock). Once games are being played the scoreboard
 *                    is what you came for, so the matchup leads, with the
 *                    lineup editor right below it for Sunday moves.
 */
const layout = computed(() => {
  switch (league.phase) {
    case 'waiver_period':
      return ['results', 'roster', 'matchup']
    case 'early_game_lock':
    case 'blanket_lock':
      return ['matchup', 'roster', 'results']
    default:
      // open and preseason: managing the roster is the job.
      return ['roster', 'matchup', 'results']
  }
})

/**
 * Keep the page live.
 *
 * A background refresh must not stomp on an edit in progress, so it skips while
 * the lineup has unsaved changes or an IR move is in flight — otherwise a poll
 * landing mid-edit would silently discard what the manager was doing.
 */
const live = useLive(
  async () => {
    if (saving.value || irBusy.value || lineupDirty.value) return
    await Promise.all([loadAll({ quiet: true }), league.refreshLocks()])
  },
  { intervalMs: 60000, immediate: false },
)

onMounted(loadAll)
</script>

<template>
  <div class="stack">
    <div v-if="message" class="alert alert-success">{{ message }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <!-- Phase and its changeover time live in the top bar now — they're
         relevant on every page, not just this one. -->

    <!-- Blocks are rendered in whatever order the current phase calls for, so
         the thing you came to do is at the top. Reordering the DOM rather than
         using CSS `order` keeps reading and tab order matching the layout. -->
    <template v-for="block in layout" :key="block">
      <!-- Your matchup -->
      <template v-if="block === 'matchup'">
        <MatchupScoreboard v-if="matchupDetail" :matchup="matchupDetail" :my-team-id="myTeamId" />
        <div v-else-if="loading" class="card"><div class="empty">Loading matchup…</div></div>
        <div v-else class="card"><div class="empty">No matchup scheduled this week.</div></div>
      </template>

      <!-- Roster, chat and locks travel together -->
      <div v-else-if="block === 'roster'" class="grid grid-2">
        <LineupEditor
          v-if="roster"
          :roster="roster"
          :team="league.myTeam"
          :can-edit="league.allows.lineup"
          :saving="saving"
          :ir-busy="irBusy"
          @save="saveLineup"
          @ir-place="moveToIr"
          @ir-activate="activateFromIr"
          @ir-swap="swapIr"
          @dirty-change="lineupDirty = $event"
          @renamed="loadAll()"
        />
        <div v-else-if="loading" class="card"><div class="empty">Loading roster…</div></div>

        <div class="stack">
          <ChatBox />

          <div class="card">
            <div class="card-header"><h2>Locks this week</h2></div>
            <div class="card-body">
              <ul v-if="earlyGames.length" class="lock-list">
                <li v-for="game in earlyGames" :key="game.id">
                  <span :class="{ 'pill pill-warn': lockedTeams.has(game.away_team) }">
                    {{ game.away_team }}
                  </span>
                  <span class="faint">@</span>
                  <span :class="{ 'pill pill-warn': lockedTeams.has(game.home_team) }">
                    {{ game.home_team }}
                  </span>
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

      <!-- Last week's results -->
      <div v-else-if="block === 'results'" class="card">
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
    </template>
  </div>
</template>

<style scoped>
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
