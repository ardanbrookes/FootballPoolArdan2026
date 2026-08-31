<script setup>
/**
 * Player pool browser.
 *
 * The action offered per player depends on their availability and the current
 * lock phase: free agents can be added instantly during the open window, while
 * anyone on waivers can only be claimed.
 */
import { ref, watch, onMounted } from 'vue'
import api from '@/api/client.js'
import PlayerChip from './PlayerChip.vue'

const props = defineProps({
  lockState: { type: Object, default: null },
  busyPlayerId: { type: String, default: null },
})

const emit = defineEmits(['add', 'claim'])

const POSITIONS = ['', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF']

const search = ref('')
const position = ref('')

// During the waiver period every unrostered player is on waivers, so defaulting
// to "free agents" would open on an empty list. Start on whichever list the
// current phase actually has players in.
const availability = ref(props.lockState?.phase === 'waiver_period' ? 'waivers' : 'free_agent')
const players = ref([])
const loading = ref(false)
const error = ref(null)
const watchedOnly = ref(false)
const week = ref(null)

let debounce

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api.searchPlayers({
      search: search.value || undefined,
      position: position.value || undefined,
      availability: availability.value || undefined,
      watched: watchedOnly.value ? 1 : undefined,
      limit: 60,
    })
    players.value = data.players
    week.value = data.week
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

/**
 * Flip the star immediately, then persist. A watchlist toggle should feel
 * instant; if the write fails we put it back and surface why.
 */
async function toggleWatch(player) {
  const next = !player.watched
  player.watched = next
  try {
    await api.setWatchlist(player.id, next)
    // Un-watching while filtered to the watchlist should drop the row.
    if (!next && watchedOnly.value) players.value = players.value.filter((p) => p.id !== player.id)
  } catch (err) {
    player.watched = !next
    error.value = err.message
  }
}

watch([search, position, availability, watchedOnly], () => {
  clearTimeout(debounce)
  debounce = setTimeout(load, 250)
})

// The parent usually resolves the lock phase after this mounts. Pick the
// sensible default when it lands, unless the manager has already chosen.
const touched = ref(false)
watch(availability, () => {
  touched.value = true
})
watch(
  () => props.lockState?.phase,
  (phase) => {
    if (touched.value || !phase) return
    availability.value = phase === 'waiver_period' ? 'waivers' : 'free_agent'
    touched.value = false
  },
)

onMounted(load)
defineExpose({ reload: load })

const canAddNow = () => props.lockState?.allows?.freeAgentAdd
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h2>Player pool</h2>
      <span class="tiny faint">{{ players.length }} shown</span>
    </div>

    <div class="filters">
      <input v-model="search" type="search" placeholder="Search players…" />
      <select v-model="position">
        <option v-for="pos in POSITIONS" :key="pos" :value="pos">{{ pos || 'All positions' }}</option>
      </select>
      <select v-model="availability">
        <option value="free_agent">Free agents</option>
        <option value="waivers">On waivers</option>
        <option value="rostered">Rostered</option>
        <option value="">Everyone</option>
      </select>
      <button
        class="btn btn-sm watch-toggle"
        :class="{ active: watchedOnly }"
        :title="watchedOnly ? 'Showing your watchlist' : 'Show only watchlisted players'"
        @click="watchedOnly = !watchedOnly"
      >
        ★ Watchlist
      </button>
    </div>

    <div v-if="error" class="card-body"><div class="alert alert-error">{{ error }}</div></div>

    <div class="card-body flush">
      <div v-if="loading && players.length === 0" class="empty">Loading…</div>
      <div v-else-if="players.length === 0" class="empty">No players match those filters.</div>

      <div v-for="player in players" :key="player.id" class="row-item">
        <button
          class="star"
          :class="{ on: player.watched }"
          :title="player.watched ? 'Remove from watchlist' : 'Add to watchlist'"
          @click="toggleWatch(player)"
        >
          {{ player.watched ? '★' : '☆' }}
        </button>

        <PlayerChip
          :player="{
            id: player.id,
            name: player.full_name,
            position: player.position,
            nflTeam: player.nfl_team,
            injuryStatus: player.injury_status,
            byeWeek: player.bye_week,
          }"
        />

        <span
          v-if="player.projectedPoints !== null && player.projectedPoints !== undefined"
          class="proj mono tiny"
          :title="`Projected ${player.projectedPoints} pts in week ${week}`"
        >
          {{ player.projectedPoints.toFixed(1) }}
        </span>

        <div class="actions">
          <span v-if="player.availability === 'rostered'" class="pill pill-info">
            {{ player.owner_team_name }}
          </span>

          <template v-else-if="player.availability === 'waivers'">
            <span class="pill pill-warn" :class="{ redundant: availability }">waivers</span>
            <button
              class="btn btn-sm"
              :disabled="busyPlayerId === player.id"
              @click="emit('claim', player)"
            >
              Claim
            </button>
          </template>

          <template v-else>
            <span class="pill pill-accent" :class="{ redundant: availability }">FA</span>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!canAddNow() || busyPlayerId === player.id"
              :title="canAddNow() ? '' : 'Free agency is closed right now'"
              @click="emit('add', player)"
            >
              Add
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.star {
  background: none;
  border: none;
  padding: 0 0.15rem;
  font-size: 1.05rem;
  line-height: 1;
  color: var(--text-faint);
  flex-shrink: 0;
}

.star:hover {
  color: var(--warn);
}

.star.on {
  color: var(--warn);
}

.proj {
  flex-shrink: 0;
  min-width: 2.6rem;
  text-align: right;
  color: var(--text-muted);
}

.watch-toggle.active {
  background: var(--warn-soft);
  border-color: var(--warn);
  color: var(--warn);
}

.filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-inset);
}

@media (max-width: 560px) {
  .filters {
    /* Search on its own row, then the two selects, then the watchlist toggle
       spanning — reads better than four stacked full-width controls. */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    padding: 0.6rem 0.75rem;
  }

  .filters input,
  .watch-toggle {
    grid-column: 1 / -1;
  }
}

.row-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}

.row-item:last-child {
  border-bottom: none;
}

.row-item:hover {
  background: var(--surface);
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* On a phone, an availability badge that just repeats the active filter costs
   ~60px of the player's name for no information. Dropped only when a specific
   filter is selected — under "Everyone" it's the only way to tell them apart. */
@media (max-width: 620px) {
  .pill.redundant {
    display: none;
  }

  .row-item {
    padding: 0.5rem 0.75rem;
    gap: 0.5rem;
  }
}
</style>
