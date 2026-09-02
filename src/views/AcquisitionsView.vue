<script setup>
/**
 * Acquisitions: the waiver wire and free agency in one place.
 * Left column is the pool; right column is your claim queue, the league's
 * priority order, and recent results.
 */
import { ref, computed, onMounted } from 'vue'
import { useLive } from '@/composables/useLive.js'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'
import LockBanner from '@/components/LockBanner.vue'
import PlayerSearch from '@/components/PlayerSearch.vue'
import DropPicker from '@/components/DropPicker.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import PlayerChip from '@/components/PlayerChip.vue'
import { formatInZone } from '@/utils/time.js'

const league = useLeagueStore()

const searchRef = ref(null)
const roster = ref(null)
const claims = ref([])
const order = ref([])
const results = ref([])
const transactions = ref([])

const picker = ref({ open: false, mode: 'add', incoming: null, required: false })
const busyPlayerId = ref(null)
const message = ref(null)
const error = ref(null)

const myTeamId = computed(() => league.myTeam?.id ?? null)
const rosterFull = computed(() => (roster.value ? roster.value.counts.total >= roster.value.counts.max : false))

const myOrderPosition = computed(() => {
  const index = order.value.findIndex((t) => t.id === myTeamId.value)
  return index >= 0 ? index + 1 : null
})

async function loadAll() {
  error.value = null
  try {
    const [rosterData, claimData, orderData, resultData, txData] = await Promise.all([
      api.roster(league.currentWeek),
      api.claims(true),
      api.waiverOrder(),
      api.waiverResults({ limit: 25 }),
      api.transactions(20),
    ])
    roster.value = rosterData.roster
    claims.value = claimData.claims
    order.value = orderData.order
    results.value = resultData.results
    transactions.value = txData.transactions.filter((t) => t.type === 'add' || t.type === 'drop')
  } catch (err) {
    error.value = err.message
  }
}

function startAdd(player) {
  picker.value = {
    open: true,
    mode: 'add',
    incoming: player,
    required: rosterFull.value && !canIr(player),
  }
}

function startClaim(player) {
  // A drop candidate is only forced when the roster is full and IR isn't open
  // to them — an IR arrival sits outside the active limit.
  picker.value = {
    open: true,
    mode: 'claim',
    incoming: player,
    required: rosterFull.value && !canIr(player),
  }
}

/** Could this player go straight to IR? Mirrors the check the server makes. */
function canIr(player) {
  const counts = roster.value?.counts
  return Boolean(player?.irEligible) && Boolean(counts) && counts.ir < counts.irMax
}

async function confirmPicker({ dropPlayerId, toIr }) {
  const { mode, incoming } = picker.value
  picker.value.open = false
  busyPlayerId.value = incoming.id
  message.value = null
  error.value = null

  try {
    if (mode === 'add') {
      await api.addFreeAgent(incoming.id, dropPlayerId, toIr)
      message.value = toIr
        ? `Added ${incoming.full_name} straight to IR.`
        : `Added ${incoming.full_name}.`
    } else {
      await api.submitClaim(incoming.id, dropPlayerId, toIr)
      message.value = toIr
        ? `Claim submitted for ${incoming.full_name} — they'll land on IR if it's awarded.`
        : `Claim submitted for ${incoming.full_name}.`
    }
    await Promise.all([loadAll(), league.refreshLocks()])
    searchRef.value?.reload()
  } catch (err) {
    error.value = err.message
  } finally {
    busyPlayerId.value = null
    setTimeout(() => (message.value = null), 4000)
  }
}

async function cancelClaim(claim) {
  try {
    const data = await api.cancelClaim(claim.id)
    claims.value = data.claims
  } catch (err) {
    error.value = err.message
  }
}

async function moveClaim(index, delta) {
  const next = [...claims.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target], next[index]]
  claims.value = next
  try {
    const data = await api.reorderClaims(next.map((c) => c.id))
    claims.value = data.claims
  } catch (err) {
    error.value = err.message
    await loadAll()
  }
}

/** Pending drop awaiting confirmation: { id, name }. */
const dropCandidate = ref(null)

function askToDrop(player) {
  dropCandidate.value = { id: player.id, name: player.name }
}

async function confirmDrop() {
  const player = dropCandidate.value
  if (!player) return

  dropCandidate.value = null
  busyPlayerId.value = player.id
  message.value = null
  error.value = null

  try {
    await api.dropPlayer(player.id)
    message.value = `Dropped ${player.name}.`
    await Promise.all([loadAll(), league.refreshLocks()])
    searchRef.value?.reload()
  } catch (err) {
    error.value = err.message
  } finally {
    busyPlayerId.value = null
    setTimeout(() => (message.value = null), 4000)
  }
}

/** IR moves share the busy indicator and refresh path with adds and drops. */
async function irAction(player, apiCall, describe) {
  busyPlayerId.value = player.id
  message.value = null
  error.value = null
  try {
    await apiCall(player.id)
    message.value = describe
    await Promise.all([loadAll(), league.refreshLocks()])
    searchRef.value?.reload()
  } catch (err) {
    error.value = err.message
  } finally {
    busyPlayerId.value = null
    setTimeout(() => (message.value = null), 4000)
  }
}

const moveToIr = (player) => irAction(player, api.placeOnIr, `${player.name} moved to injured reserve.`)
const activateIr = (player) => irAction(player, api.activateFromIr, `${player.name} activated from IR.`)

const when = (iso) => formatInZone(iso, league.config?.timing?.timezone)

/**
 * Keep the pool, claims and results current.
 *
 * Held off while a move is in flight or a dialog is open — refreshing the list
 * out from under an open drop-picker would change what the buttons mean.
 */
const live = useLive(
  async () => {
    if (busyPlayerId.value || picker.value.open || dropCandidate.value) return
    await Promise.all([loadAll(), league.refreshLocks()])
    searchRef.value?.reload()
  },
  { intervalMs: 45000, immediate: false },
)

onMounted(loadAll)
</script>

<template>
  <div class="stack">
    <LockBanner :lock-state="league.lockState" />

    <div v-if="message" class="alert alert-success">{{ message }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="layout">
      <div class="stack">
        <PlayerSearch
          ref="searchRef"
          :lock-state="league.lockState"
          :busy-player-id="busyPlayerId"
          @add="startAdd"
          @claim="startClaim"
        />

        <div class="card">
          <div class="card-header">
            <h2>Recent acquisitions</h2>
          </div>
          <div class="card-body flush">
            <div v-if="transactions.length === 0" class="empty">Nothing yet this season.</div>
            <div v-for="tx in transactions" :key="tx.id" class="tx-row">
              <span class="pill" :class="tx.type === 'add' ? 'pill-accent' : 'pill-danger'">
                {{ tx.type === 'add' ? '+' : '−' }}
              </span>
              <div style="flex: 1; min-width: 0">
                <div class="small">
                  <span class="bold">{{ tx.team_name }}</span>
                  {{ tx.type === 'add' ? 'added' : 'dropped' }}
                  {{ tx.player_name }}
                </div>
                <div class="tiny faint">{{ tx.source }} · {{ when(tx.created_at) }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-header">
            <h2>Your claims</h2>
            <span class="tiny faint">{{ claims.length }} pending</span>
          </div>
          <div class="card-body flush">
            <div v-if="claims.length === 0" class="empty">
              No pending claims. Claims process
              {{ league.lockState?.cycle?.waiverProcessAt ? when(league.lockState.cycle.waiverProcessAt) : 'Tuesday 3am' }}.
            </div>
            <div v-for="(claim, index) in claims" :key="claim.id" class="claim-row">
              <div class="claim-priority mono">{{ index + 1 }}</div>
              <div style="flex: 1; min-width: 0">
                <div class="small bold">{{ claim.add_player_name }}</div>
                <div class="tiny faint">
                  {{ claim.add_position }} · {{ claim.add_nfl_team }}
                  <template v-if="claim.drop_player_name"> · drop {{ claim.drop_player_name }}</template>
                </div>
              </div>
              <div class="claim-actions">
                <button class="btn btn-ghost btn-sm" :disabled="index === 0" @click="moveClaim(index, -1)">↑</button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="index === claims.length - 1"
                  @click="moveClaim(index, 1)"
                >
                  ↓
                </button>
                <button class="btn btn-ghost btn-sm btn-danger" @click="cancelClaim(claim)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Waiver priority (TSLC)</h2>
            <span v-if="myOrderPosition" class="pill pill-accent">You're #{{ myOrderPosition }}</span>
          </div>
          <div class="card-body flush">
            <div v-for="(team, index) in order" :key="team.id" class="order-row" :class="{ mine: team.id === myTeamId }">
              <span class="mono faint" style="width: 1.5rem">{{ index + 1 }}</span>
              <span class="small" style="flex: 1">{{ team.name }}</span>
              <span class="tiny faint">
                {{ team.last_waiver_claim_at ? when(team.last_waiver_claim_at) : 'never claimed' }}
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>Waiver results</h2></div>
          <div class="card-body flush">
            <div v-if="results.length === 0" class="empty">No processed claims yet.</div>
            <div v-for="result in results" :key="result.id" class="result-row">
              <span class="pill" :class="result.status === 'success' ? 'pill-accent' : 'pill-danger'">
                {{ result.status === 'success' ? 'won' : 'lost' }}
              </span>
              <div style="flex: 1; min-width: 0">
                <div class="small">
                  <span class="bold">{{ result.team_name }}</span> · {{ result.add_player_name }}
                </div>
                <div class="tiny faint">{{ result.result_reason }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="roster" class="card">
          <div class="card-header">
            <h2>Your roster</h2>
            <span class="tiny faint">
              {{ roster.counts.total }} / {{ roster.counts.max }}
              <template v-if="roster.counts.irMax">· IR {{ roster.counts.ir }}/{{ roster.counts.irMax }}</template>
            </span>
          </div>
          <div class="card-body flush">
            <div
              v-for="player in [...roster.starters.map((s) => s.player).filter(Boolean), ...roster.bench]"
              :key="player.id"
              class="tx-row"
            >
              <PlayerChip :player="player" />
              <div class="row-actions">
                <button
                  v-if="roster.irCandidates?.includes(player.id)"
                  class="btn btn-sm"
                  :disabled="player.locked || !league.allows.lineup || busyPlayerId === player.id || roster.counts.ir >= roster.counts.irMax"
                  :title="
                    roster.counts.ir >= roster.counts.irMax
                      ? 'IR slot is full'
                      : `Store ${player.name} on IR while injured`
                  "
                  @click="moveToIr(player)"
                >
                  → IR
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  :disabled="player.locked || !league.allows.drop || busyPlayerId === player.id"
                  :title="player.lockReason || ''"
                  @click="askToDrop(player)"
                >
                  Drop
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="roster && roster.counts.irMax" class="card">
          <div class="card-header">
            <h2>Injured reserve</h2>
            <span class="tiny faint">{{ roster.counts.ir }} / {{ roster.counts.irMax }}</span>
          </div>
          <div class="card-body flush">
            <div v-if="roster.ir.length === 0" class="empty small">
              Empty. Injured players parked here don't count against your
              {{ roster.counts.max }}-player limit.
            </div>
            <div v-for="player in roster.ir" :key="player.id" class="tx-row">
              <PlayerChip :player="player" />
              <div class="row-actions">
                <span v-if="player.healthyOnIr" class="pill pill-warn tiny" title="No longer injured — activate or drop">
                  healthy
                </span>
                <button
                  class="btn btn-sm"
                  :disabled="!league.allows.lineup || busyPlayerId === player.id"
                  @click="activateIr(player)"
                >
                  Activate
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="Boolean(dropCandidate)"
      title="Drop this player?"
      :message="`${dropCandidate?.name} will be removed from your roster.`"
      :detail="`They go on waivers until ${
        league.lockState?.cycle?.waiverProcessAt ? when(league.lockState.cycle.waiverProcessAt) : 'the next processing run'
      }, so anyone in the league can claim them. You can't simply take them back.`"
      confirm-label="Drop player"
      destructive
      :busy="Boolean(busyPlayerId)"
      @confirm="confirmDrop"
      @cancel="dropCandidate = null"
    />

    <DropPicker
      :open="picker.open"
      :incoming="picker.incoming"
      :roster="roster"
      :mode="picker.mode"
      :required="picker.required"
      :roster-full="rosterFull"
      :busy="Boolean(busyPlayerId)"
      @confirm="confirmPicker"
      @cancel="picker.open = false"
    />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@media (max-width: 900px) {
  /* minmax(0, 1fr), not 1fr: a bare 1fr keeps an auto minimum, so a wide child
     stretches the track past the viewport instead of being clipped to it. */
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.tx-row,
.claim-row,
.result-row,
.order-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}

.tx-row:last-child,
.claim-row:last-child,
.result-row:last-child,
.order-row:last-child {
  border-bottom: none;
}

.order-row.mine {
  background: var(--accent-soft);
}

.claim-priority {
  width: 1.5rem;
  height: 1.5rem;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.claim-actions {
  display: flex;
  gap: 0.15rem;
  flex-shrink: 0;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}
</style>
