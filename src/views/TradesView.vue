<script setup>
/**
 * Trades: build an offer, review incoming requests, track your pending offers,
 * and see what's been accepted around the league.
 */
import { ref, computed, onMounted, watch } from 'vue'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'
import PlayerChip from '@/components/PlayerChip.vue'

const league = useLeagueStore()

const myRoster = ref(null)
const theirRoster = ref(null)
const allRosters = ref([])
const trades = ref([])
const partnerId = ref(null)
const give = ref([])
const receive = ref([])
const note = ref('')
const busy = ref(false)
const message = ref(null)
const error = ref(null)

const myTeamId = computed(() => league.myTeam?.id ?? null)
const partners = computed(() => allRosters.value.filter((t) => t.id !== myTeamId.value))

const incoming = computed(() =>
  trades.value.filter((t) => t.status === 'pending' && t.receiver_team_id === myTeamId.value),
)
const outgoing = computed(() =>
  trades.value.filter((t) => t.status === 'pending' && t.proposer_team_id === myTeamId.value),
)
const settled = computed(() => trades.value.filter((t) => t.status !== 'pending'))

const myPlayers = computed(() => [
  ...(myRoster.value?.starters || []).map((s) => s.player).filter(Boolean),
  ...(myRoster.value?.bench || []),
])

const theirPlayers = computed(() => {
  if (!partnerId.value) return []
  const team = allRosters.value.find((t) => t.id === partnerId.value)
  if (!team) return []
  return [
    ...team.starters.map((s) => s.player).filter(Boolean).map((p) => ({ ...p, name: p.name })),
    ...team.bench.map((p) => ({ ...p, name: p.name })),
  ]
})

async function loadAll() {
  error.value = null
  try {
    const [rosterData, rostersData, tradeData] = await Promise.all([
      api.roster(league.currentWeek),
      api.rosters(league.currentWeek),
      api.trades({ mine: 1 }),
    ])
    myRoster.value = rosterData.roster
    allRosters.value = rostersData.teams
    trades.value = tradeData.trades
  } catch (err) {
    error.value = err.message
  }
}

/**
 * Add/remove a player from one side of the offer.
 *
 * Takes the side by name rather than the ref itself: Vue unwraps top-level refs
 * in templates, so `toggle(give, id)` would hand this function a plain array and
 * `.value` would be undefined.
 */
function toggle(side, id) {
  const list = side === 'give' ? give : receive
  const index = list.value.indexOf(id)
  if (index >= 0) list.value.splice(index, 1)
  else list.value.push(id)
}

// --- draft picks (record-keeping only) ---
const givePicks = ref([])
const receivePicks = ref([])
const pickSide = ref('give')
const pickRound = ref(1)

/** Next two drafts — you can't trade a pick in a draft that's already happened. */
const pickSeasons = computed(() => {
  const base = (league.league?.season ?? new Date().getFullYear()) + 1
  return [base, base + 1]
})
const pickSeason = ref(null)
watch(pickSeasons, (seasons) => {
  if (!pickSeason.value) pickSeason.value = seasons[0]
}, { immediate: true })

function addPick() {
  const list = pickSide.value === 'give' ? givePicks : receivePicks
  const pick = { season: pickSeason.value, round: pickRound.value }
  // Silently ignore an exact duplicate rather than recording the same pick twice.
  if (list.value.some((p) => p.season === pick.season && p.round === pick.round)) return
  list.value.push(pick)
}

function resetBuilder() {
  give.value = []
  receive.value = []
  givePicks.value = []
  receivePicks.value = []
  note.value = ''
}

async function propose() {
  busy.value = true
  message.value = null
  error.value = null
  try {
    await api.proposeTrade({
      receiverTeamId: partnerId.value,
      give: give.value,
      receive: receive.value,
      givePicks: givePicks.value,
      receivePicks: receivePicks.value,
      message: note.value || undefined,
    })
    message.value = 'Offer sent.'
    resetBuilder()
    await loadAll()
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
    setTimeout(() => (message.value = null), 4000)
  }
}

async function respond(trade, accept) {
  busy.value = true
  error.value = null
  try {
    await api.respondToTrade(trade.id, accept)
    message.value = accept ? 'Trade accepted.' : 'Trade rejected.'
    await Promise.all([loadAll(), league.load()])
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
    setTimeout(() => (message.value = null), 4000)
  }
}

async function cancel(trade) {
  busy.value = true
  try {
    await api.cancelTrade(trade.id)
    await loadAll()
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}

// A picks-only offer is a legitimate offer, so it counts toward "has content".
const canSubmit = computed(
  () =>
    partnerId.value &&
    (give.value.length ||
      receive.value.length ||
      givePicks.value.length ||
      receivePicks.value.length) &&
    !busy.value &&
    league.allows.trade,
)

onMounted(loadAll)
</script>

<template>
  <div class="stack">
    <div v-if="message" class="alert alert-success">{{ message }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="card">
      <div class="card-header">
        <h2>Offer a trade</h2>
        <select v-model="partnerId" style="max-width: 16rem">
          <option :value="null">Choose a team…</option>
          <option v-for="team in partners" :key="team.id" :value="team.id">{{ team.name }}</option>
        </select>
      </div>

      <div class="card-body">
        <div v-if="!league.allows.trade" class="alert alert-warn" style="margin-bottom: 1rem">
          Trades are closed during {{ league.lockState?.phaseLabel?.toLowerCase() }}.
        </div>

        <div class="builder">
          <div>
            <h3 class="small bold" style="margin-bottom: 0.5rem">You send</h3>
            <div class="picker-list">
              <button
                v-for="player in myPlayers"
                :key="player.id"
                class="pick"
                :class="{ selected: give.includes(player.id) }"
                :disabled="player.locked"
                :title="player.lockReason || ''"
                @click="toggle('give', player.id)"
              >
                <PlayerChip :player="player" />
              </button>
            </div>
          </div>

          <div>
            <h3 class="small bold" style="margin-bottom: 0.5rem">You receive</h3>
            <div v-if="!partnerId" class="empty small">Pick a team to see their roster.</div>
            <div v-else class="picker-list">
              <button
                v-for="player in theirPlayers"
                :key="player.id"
                class="pick"
                :class="{ selected: receive.includes(player.id) }"
                :disabled="player.locked"
                :title="player.lockReason || ''"
                @click="toggle('receive', player.id)"
              >
                <PlayerChip :player="player" />
              </button>
            </div>
          </div>
        </div>

        <!-- Picks are recorded only — nothing in the app drafts, so these exist
             so next year's order can be set by hand from an agreed record. -->
        <div class="picks">
          <div class="row-between" style="margin-bottom: 0.4rem">
            <h3 class="small bold" style="margin: 0">Draft picks</h3>
            <span class="tiny faint">Tracked for next year's draft — no effect in-app</span>
          </div>

          <div class="pick-builder">
            <select v-model="pickSide">
              <option value="give">You send</option>
              <option value="receive">You receive</option>
            </select>
            <select v-model.number="pickSeason">
              <option v-for="y in pickSeasons" :key="y" :value="y">{{ y }}</option>
            </select>
            <select v-model.number="pickRound">
              <option v-for="r in 10" :key="r" :value="r">Round {{ r }}</option>
            </select>
            <button class="btn btn-sm" @click="addPick">Add pick</button>
          </div>

          <div v-if="givePicks.length || receivePicks.length" class="pick-lists">
            <div>
              <div class="tiny faint">You send</div>
              <div v-if="!givePicks.length" class="tiny faint">—</div>
              <button
                v-for="(p, i) in givePicks"
                :key="`g${i}`"
                class="pick-chip"
                title="Remove"
                @click="givePicks.splice(i, 1)"
              >
                {{ p.season }} R{{ p.round }} ✕
              </button>
            </div>
            <div>
              <div class="tiny faint">You receive</div>
              <div v-if="!receivePicks.length" class="tiny faint">—</div>
              <button
                v-for="(p, i) in receivePicks"
                :key="`r${i}`"
                class="pick-chip"
                title="Remove"
                @click="receivePicks.splice(i, 1)"
              >
                {{ p.season }} R{{ p.round }} ✕
              </button>
            </div>
          </div>
        </div>

        <div style="margin-top: 1rem">
          <label for="note">Message (optional)</label>
          <input id="note" v-model="note" placeholder="Add a note to this offer…" />
        </div>

        <div class="row" style="justify-content: flex-end; margin-top: 0.75rem">
          <button class="btn btn-ghost btn-sm" @click="resetBuilder">Clear</button>
          <button class="btn btn-primary btn-sm" :disabled="!canSubmit" @click="propose">Send offer</button>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-header">
          <h2>Trade requests</h2>
          <span class="tiny faint">{{ incoming.length }}</span>
        </div>
        <div class="card-body flush">
          <div v-if="incoming.length === 0" class="empty">No incoming offers.</div>
          <div v-for="trade in incoming" :key="trade.id" class="trade">
            <div class="trade-head small">
              <span class="bold">{{ trade.proposer_name }}</span> offers
            </div>
            <div class="trade-body">
              <div>
                <div class="tiny faint">You get</div>
                <div v-for="p in trade.proposerGives" :key="p.id" class="small">{{ p.full_name }}</div>
                <div v-for="p in trade.proposerPicks" :key="`p${p.id}`" class="small pick-note">
                  {{ p.season }} Round {{ p.round }} pick
                </div>
                <div v-if="!trade.proposerGives.length" class="tiny faint">nothing</div>
              </div>
              <div>
                <div class="tiny faint">You give</div>
                <div v-for="p in trade.receiverGives" :key="p.id" class="small">{{ p.full_name }}</div>
                <div v-for="p in trade.receiverPicks" :key="`p${p.id}`" class="small pick-note">
                  {{ p.season }} Round {{ p.round }} pick
                </div>
                <div v-if="!trade.receiverGives.length" class="tiny faint">nothing</div>
              </div>
            </div>
            <p v-if="trade.message" class="tiny muted trade-note">"{{ trade.message }}"</p>
            <div class="row" style="justify-content: flex-end">
              <button class="btn btn-sm btn-danger" :disabled="busy" @click="respond(trade, false)">Reject</button>
              <button class="btn btn-sm btn-primary" :disabled="busy" @click="respond(trade, true)">Accept</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Your pending offers</h2>
          <span class="tiny faint">{{ outgoing.length }}</span>
        </div>
        <div class="card-body flush">
          <div v-if="outgoing.length === 0" class="empty">You haven't offered any trades.</div>
          <div v-for="trade in outgoing" :key="trade.id" class="trade">
            <div class="trade-head small">
              To <span class="bold">{{ trade.receiver_name }}</span>
            </div>
            <div class="trade-body">
              <div>
                <div class="tiny faint">You give</div>
                <div v-for="p in trade.proposerGives" :key="p.id" class="small">{{ p.full_name }}</div>
                <div v-for="p in trade.proposerPicks" :key="`p${p.id}`" class="small pick-note">
                  {{ p.season }} Round {{ p.round }} pick
                </div>
              </div>
              <div>
                <div class="tiny faint">You get</div>
                <div v-for="p in trade.receiverGives" :key="p.id" class="small">{{ p.full_name }}</div>
                <div v-for="p in trade.receiverPicks" :key="`p${p.id}`" class="small pick-note">
                  {{ p.season }} Round {{ p.round }} pick
                </div>
              </div>
            </div>
            <div class="row" style="justify-content: flex-end">
              <button class="btn btn-sm btn-ghost" :disabled="busy" @click="cancel(trade)">Cancel offer</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Recent trades</h2></div>
      <div class="card-body flush">
        <div v-if="settled.length === 0" class="empty">No completed trades yet.</div>
        <div v-for="trade in settled" :key="trade.id" class="trade">
          <div class="row-between">
            <span class="small">
              <span class="bold">{{ trade.proposer_abbr }}</span> ↔
              <span class="bold">{{ trade.receiver_abbr }}</span>
            </span>
            <span class="pill" :class="trade.status === 'accepted' ? 'pill-accent' : 'pill-danger'">
              {{ trade.status }}
            </span>
          </div>
          <div class="trade-body">
            <div>
              <div class="tiny faint">{{ trade.proposer_abbr }} sent</div>
              <div v-for="p in trade.proposerGives" :key="p.id" class="small">{{ p.full_name }}</div>
            </div>
            <div>
              <div class="tiny faint">{{ trade.receiver_abbr }} sent</div>
              <div v-for="p in trade.receiverGives" :key="p.id" class="small">{{ p.full_name }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.builder {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

@media (max-width: 700px) {
  .builder {
    grid-template-columns: minmax(0, 1fr);
  }
}

.picker-list {
  max-height: 18rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.pick {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.6rem;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: inherit;
}

.pick:last-child {
  border-bottom: none;
}

.pick:hover:not(:disabled) {
  background: var(--surface);
}

.pick.selected {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.pick:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.trade {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.trade:last-child {
  border-bottom: none;
}

.trade-head {
  margin-bottom: 0.5rem;
}

.trade-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.trade-note {
  font-style: italic;
  margin: 0 0 0.5rem;
}

/* ---- draft picks ---- */

.picks {
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
}

.pick-builder {
  display: grid;
  grid-template-columns: auto auto auto auto;
  gap: 0.4rem;
  justify-content: start;
}

@media (max-width: 620px) {
  .pick-builder {
    grid-template-columns: 1fr 1fr;
  }
}

.pick-lists {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin-top: 0.6rem;
}

.pick-chip {
  display: inline-block;
  margin: 0.2rem 0.3rem 0 0;
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 0.72rem;
  font-family: var(--mono);
}

.pick-chip:hover {
  border-color: var(--danger);
  color: var(--danger);
}

/* Picks read as a different kind of asset to players. */
.pick-note {
  color: var(--info);
  font-family: var(--mono);
  font-size: 0.78rem;
}
</style>
