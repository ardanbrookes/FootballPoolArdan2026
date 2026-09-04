<script setup>
/**
 * Trades: build an offer, review incoming requests, track your pending offers,
 * and see what's been accepted around the league.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useLive } from '@/composables/useLive.js'
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
const listings = ref([])
const blockBusyId = ref(null)
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
    const [rosterData, rostersData, tradeData, blockData] = await Promise.all([
      api.roster(league.currentWeek),
      api.rosters(league.currentWeek),
      api.trades({ mine: 1 }),
      api.tradeBlock(),
    ])
    myRoster.value = rosterData.roster
    allRosters.value = rostersData.teams
    trades.value = tradeData.trades
    listings.value = blockData.listings
  } catch (err) {
    error.value = err.message
  }
}

/**
 * List or unlist one of your own players.
 *
 * Listing announces it in chat — the whole point is that the other seven
 * managers find out. Unlisting is silent; nobody needs a notification every
 * time somebody changes their mind.
 */
async function toggleBlock(player) {
  blockBusyId.value = player.id
  error.value = null
  try {
    const result = await api.setTradeBlock(player.id, !player.onTradeBlock)
    listings.value = result.listings
    // Reload so the roster's own flags match what the server now thinks.
    const rosterData = await api.roster(league.currentWeek)
    myRoster.value = rosterData.roster
    message.value = result.listed
      ? `${player.name} is on the trade block.`
      : `${player.name} is off the trade block.`
    setTimeout(() => (message.value = null), 4000)
  } catch (err) {
    error.value = err.message
  } finally {
    blockBusyId.value = null
  }
}

/** Listings from the other seven managers. */
const theirListings = computed(() => listings.value.filter((l) => l.teamId !== myTeamId.value))

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

function resetBuilder() {
  give.value = []
  receive.value = []
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

const canSubmit = computed(
  () =>
    partnerId.value &&
    (give.value.length || receive.value.length) &&
    !busy.value &&
    league.allows.trade,
)

/**
 * Poll for incoming offers.
 *
 * Skipped while an offer is being built or sent — a refresh mid-build would
 * reload the rosters underneath the selections and lose them.
 */
const live = useLive(
  async () => {
    const building = give.value.length || receive.value.length
    if (busy.value || building) return
    await loadAll()
  },
  { intervalMs: 60000, immediate: false },
)

onMounted(loadAll)
</script>

<template>
  <div class="stack">
    <div v-if="message" class="alert alert-success">{{ message }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="card">
      <div class="card-header">
        <h2>Trade block</h2>
        <span class="tiny faint">{{ listings.length }} listed</span>
      </div>
      <div class="card-body">
        <p v-if="!listings.length" class="empty small" style="margin: 0">
          Nobody has listed anyone yet. Star a player below to say you're open to moving them —
          it gets announced in chat.
        </p>
        <div v-else class="block-grid">
          <div v-for="item in listings" :key="item.teamId + ':' + item.player.id" class="listing">
            <PlayerChip :player="item.player" />
            <button
              v-if="item.teamId !== myTeamId"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="!league.allows.trade"
              @click="partnerId = item.teamId"
            >
              {{ item.teamName }} ↗
            </button>
            <span v-else class="tiny faint yours">yours</span>
          </div>
        </div>
      </div>
    </div>

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
            <h3 class="small bold">You send</h3>
            <div class="picker-list">
              <div v-for="player in myPlayers" :key="player.id" class="pick-row">
                <button
                  class="pick"
                  :class="{ selected: give.includes(player.id) }"
                  :disabled="player.locked"
                  :title="player.lockReason || ''"
                  @click="toggle('give', player.id)"
                >
                  <PlayerChip :player="player" />
                  <span class="ros mono tiny" title="Projected points, rest of season">
                    {{ (player.restOfSeasonPoints ?? 0).toFixed(0) }}
                  </span>
                </button>
                <button
                  class="block-toggle"
                  :class="{ on: player.onTradeBlock }"
                  type="button"
                  :disabled="blockBusyId === player.id"
                  :title="
                    player.onTradeBlock
                      ? 'On the trade block — click to remove'
                      : 'Put on the trade block (announces it in chat)'
                  "
                  @click="toggleBlock(player)"
                >
                  {{ player.onTradeBlock ? '★' : '☆' }}
                </button>
              </div>
            </div>
          </div>

          <div>
            <h3 class="small bold">You receive</h3>
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
                <span class="ros mono tiny" title="Projected points, rest of season">
                  {{ (player.restOfSeasonPoints ?? 0).toFixed(0) }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- Picks are recorded only — nothing in the app drafts, so these exist
             so next year's order can be set by hand from an agreed record. -->
        <div style="margin-top: 1rem">
          <label for="note">Message (optional)</label>
          <input id="note" v-model="note" placeholder="Add a note to this offer…" />
        </div>

        <div class="row submit-row">
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
              <span class="bold">{{ trade.proposer_name }}</span> ↔
              <span class="bold">{{ trade.receiver_name }}</span>
            </span>
            <span class="pill" :class="trade.status === 'accepted' ? 'pill-accent' : 'pill-danger'">
              {{ trade.status }}
            </span>
          </div>
          <div class="trade-body">
            <div>
              <div class="tiny faint">{{ trade.proposer_name }} sent</div>
              <div v-for="p in trade.proposerGives" :key="p.id" class="small">{{ p.full_name }}</div>
              <div v-for="p in trade.proposerPicks" :key="`p${p.id}`" class="small pick-note">
                {{ p.season }} Round {{ p.round }} pick
              </div>
              <div v-if="!trade.proposerGives.length && !trade.proposerPicks.length" class="tiny faint">
                nothing
              </div>
            </div>
            <div>
              <div class="tiny faint">{{ trade.receiver_name }} sent</div>
              <div v-for="p in trade.receiverGives" :key="p.id" class="small">{{ p.full_name }}</div>
              <div v-for="p in trade.receiverPicks" :key="`p${p.id}`" class="small pick-note">
                {{ p.season }} Round {{ p.round }} pick
              </div>
              <div v-if="!trade.receiverGives.length && !trade.receiverPicks.length" class="tiny faint">
                nothing
              </div>
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

.builder h3 {
  margin-bottom: 0.5rem;
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

/* Picks read as a different kind of asset to players. */
.pick-note {
  color: var(--info);
  font-family: var(--mono);
  font-size: 0.78rem;
}
.pick-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.25rem;
  align-items: stretch;
}

.block-toggle {
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-faint);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
}

.block-toggle:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}

.block-toggle.on {
  color: var(--warn);
  border-color: var(--warn);
  background: var(--warn-soft);
}

.block-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
  gap: 0.4rem;
}

.listing {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.4rem;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}

.yours {
  white-space: nowrap;
}
.pick {
  position: relative;
}

.submit-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}

.ros {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
}

.pick.selected .ros {
  color: var(--accent-hover);
}
</style>
