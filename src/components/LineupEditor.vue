<script setup>
/**
 * Roster editor — starters, bench and IR in one place.
 *
 * Tap a slot to see who can fill it; picking someone swaps them in and moves
 * whoever was there to the bench. Locked players are shown but not selectable,
 * so the Thursday-night rule is visible up front rather than arriving as an
 * error after the fact.
 *
 * IR is deliberately not part of the lineup save. Placing or activating a player
 * changes roster shape rather than the week's lineup, so it goes through its own
 * endpoints and takes effect immediately — the parent handles those events.
 */
import { ref, computed, watch } from 'vue'
import PlayerChip from './PlayerChip.vue'
import TeamNameEditor from './TeamNameEditor.vue'

const props = defineProps({
  /** The signed-in manager's team, for the rename control. */
  team: { type: Object, default: null },
  roster: { type: Object, required: true },
  canEdit: { type: Boolean, default: true },
  saving: { type: Boolean, default: false },
  /** Set while an IR move is in flight, to avoid double submits. */
  irBusy: { type: Boolean, default: false },
})

const emit = defineEmits(['save', 'ir-place', 'ir-activate', 'ir-swap', 'dirty-change', 'renamed'])

const teamName = computed(() => props.team?.name ?? null)

const openSlot = ref(null)
const draft = ref(null)

/** Working copy: { slotId: playerId | null } */
const assignments = computed(() => {
  if (draft.value) return draft.value
  return Object.fromEntries(props.roster.starters.map((s) => [s.slot, s.player?.id ?? null]))
})

const dirty = computed(() => {
  if (!draft.value) return false
  return props.roster.starters.some((s) => (s.player?.id ?? null) !== (draft.value[s.slot] ?? null))
})

// The parent polls in the background; it needs to know not to refresh over the
// top of edits that haven't been saved yet.
watch(dirty, (value) => emit('dirty-change', value))

/** Everyone available to start — IR players are excluded by construction. */
const allPlayers = computed(() => {
  const map = new Map()
  for (const slot of props.roster.starters) if (slot.player) map.set(slot.player.id, slot.player)
  for (const player of props.roster.bench) map.set(player.id, player)
  return map
})

const playerFor = (slotId) => {
  const id = assignments.value[slotId]
  return id ? allPlayers.value.get(id) : null
}

/** Anyone not currently in a starting slot, under the working assignments. */
const benchNow = computed(() => {
  const starting = new Set(Object.values(assignments.value).filter(Boolean))
  return [...allPlayers.value.values()]
    .filter((p) => !starting.has(p.id))
    .sort((a, b) => (a.position ?? '').localeCompare(b.position ?? '') || a.name.localeCompare(b.name))
})

function candidatesFor(slot) {
  const current = playerFor(slot.slot)
  return benchNow.value
    .filter((p) => (p.eligiblePositions || [p.position]).some((pos) => slot.eligible.includes(pos)))
    .filter((p) => p.id !== current?.id)
}

function ensureDraft() {
  if (!draft.value) {
    draft.value = Object.fromEntries(props.roster.starters.map((s) => [s.slot, s.player?.id ?? null]))
  }
}

function toggleSlot(slot) {
  if (!props.canEdit) return
  if (playerFor(slot.slot)?.locked) return
  openSlot.value = openSlot.value === slot.slot ? null : slot.slot
}

function assign(slotId, playerId) {
  ensureDraft()
  // If that player is starting elsewhere, swap the two slots.
  const existingSlot = Object.keys(draft.value).find((s) => draft.value[s] === playerId)
  const displaced = draft.value[slotId] ?? null
  if (existingSlot) draft.value[existingSlot] = displaced
  draft.value[slotId] = playerId
  openSlot.value = null
}

function clearSlot(slotId) {
  ensureDraft()
  draft.value[slotId] = null
  openSlot.value = null
}

function reset() {
  draft.value = null
  openSlot.value = null
}

function save() {
  emit('save', { ...assignments.value }, reset)
}

/**
 * Projected total for the starting lineup.
 *
 * Sums `projectedPoints`, not `points`. It used to sum points already scored,
 * which meant this read 0.0 all week until games started — the Acquisitions
 * page looked right only because it fetches projections separately.
 *
 * Recomputed from the live assignments rather than the server total, so
 * swapping someone in updates the number before you save.
 */
const projected = computed(() =>
  props.roster.starters.reduce((sum, s) => sum + (playerFor(s.slot)?.projectedPoints ?? 0), 0),
)

/** What the starters have actually banked so far. */
const scored = computed(() =>
  props.roster.starters.reduce((sum, s) => sum + (playerFor(s.slot)?.points ?? 0), 0),
)

// ---- injured reserve ----

const irOpen = ref(false)
const irSlots = computed(() => props.roster.counts?.irMax ?? 0)
const irPlayers = computed(() => props.roster.ir ?? [])

/** Rostered players eligible for IR right now, per the server's own rule. */
const irCandidates = computed(() => {
  const ids = new Set(props.roster.irCandidates ?? [])
  return [...allPlayers.value.values()].filter((p) => ids.has(p.id))
})

function toggleIr() {
  if (!props.canEdit || props.irBusy) return
  irOpen.value = !irOpen.value
}

function placeOnIr(player) {
  irOpen.value = false
  emit('ir-place', player)
}

/**
 * When IR is full, offer a swap instead of a dead end.
 *
 * Activating normally needs a free roster spot, so a full roster with a full IR
 * would force a drop just to shelve a newly injured player. Swapping nets out —
 * one comes off IR to the bench as the other goes on — so nobody is lost.
 */
const irFull = computed(() => irPlayers.value.length >= irSlots.value && irSlots.value > 0)
const swapOpenFor = ref(null)

function toggleSwap(irPlayer) {
  if (!props.canEdit || props.irBusy) return
  swapOpenFor.value = swapOpenFor.value === irPlayer.id ? null : irPlayer.id
}

function doSwap(irPlayer, incoming) {
  swapOpenFor.value = null
  emit('ir-swap', { activate: irPlayer, place: incoming })
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <div class="title-row">
        <h2>{{ teamName || 'Your roster' }}</h2>
        <TeamNameEditor v-if="team" :team="team" @renamed="emit('renamed', $event)" />
      </div>
      <div class="row totals">
        <template v-if="scored > 0">
          <span class="tiny faint">Scored</span>
          <span class="mono bold">{{ scored.toFixed(1) }}</span>
        </template>
        <span class="tiny faint">Projected</span>
        <span class="mono bold">{{ projected.toFixed(1) }}</span>
      </div>
    </div>

    <div class="card-body flush">
      <!-- Starters -->
      <div v-for="slot in roster.starters" :key="slot.slot" class="slot-group">
        <button
          class="slot"
          :class="{ open: openSlot === slot.slot, empty: !playerFor(slot.slot), disabled: !canEdit }"
          @click="toggleSlot(slot)"
        >
          <span class="slot-label tiny">{{ slot.label }}</span>
          <PlayerChip v-if="playerFor(slot.slot)" :player="playerFor(slot.slot)" show-points />
          <span v-else class="faint small">Empty — tap to fill</span>
          <span v-if="canEdit && !playerFor(slot.slot)?.locked" class="chev faint">›</span>
        </button>

        <div v-if="openSlot === slot.slot" class="picker">
          <div v-if="candidatesFor(slot).length === 0" class="empty small">
            No eligible players for {{ slot.label }}.
          </div>
          <button
            v-for="candidate in candidatesFor(slot)"
            :key="candidate.id"
            class="candidate"
            :disabled="candidate.locked"
            :title="candidate.lockReason || ''"
            @click="assign(slot.slot, candidate.id)"
          >
            <PlayerChip :player="candidate" show-points />
          </button>
          <button v-if="playerFor(slot.slot)" class="candidate clear" @click="clearSlot(slot.slot)">
            Move {{ playerFor(slot.slot).name }} to bench
          </button>
        </div>
      </div>

      <!-- Bench, in the same card: it's one roster, not two lists. -->
      <div class="section-head tiny">
        Bench — scores nothing
        <span class="faint">{{ benchNow.length }} / {{ roster.counts.benchMax }}</span>
      </div>

      <div v-if="benchNow.length === 0" class="empty small">Bench is empty.</div>
      <div v-for="player in benchNow" :key="player.id" class="slot bench-row">
        <span class="slot-label tiny">BN</span>
        <PlayerChip :player="player" show-points />
      </div>

      <!-- IR last: it isn't part of the week's lineup and scores nothing. -->
      <template v-if="irSlots">
        <div class="section-head tiny">
          Injured reserve — scores nothing
          <span class="faint">{{ irPlayers.length }} / {{ irSlots }}</span>
        </div>

        <div v-for="player in irPlayers" :key="player.id" class="slot-group">
          <div class="slot ir-row">
            <span class="slot-label tiny">IR</span>
            <PlayerChip :player="player" />
            <span v-if="player.healthyOnIr" class="pill pill-warn tiny" title="No longer injured">
              healthy
            </span>
            <button
              v-if="irFull && irCandidates.length"
              class="btn btn-sm"
              :disabled="!canEdit || irBusy"
              title="Swap this player out and another injured player in"
              @click="toggleSwap(player)"
            >
              Swap
            </button>
            <button
              class="btn btn-sm"
              :disabled="!canEdit || irBusy"
              @click="emit('ir-activate', player)"
            >
              Activate
            </button>
          </div>

          <div v-if="swapOpenFor === player.id" class="picker">
            <div class="swap-note tiny faint">
              {{ player.name }} moves to your bench, and whoever you pick takes the IR slot. No drop
              needed.
            </div>
            <button
              v-for="candidate in irCandidates"
              :key="candidate.id"
              class="candidate"
              :disabled="candidate.locked || irBusy"
              :title="candidate.lockReason || ''"
              @click="doSwap(player, candidate)"
            >
              <PlayerChip :player="candidate" />
            </button>
          </div>
        </div>

        <template v-if="irPlayers.length < irSlots">
          <button class="slot ir-empty" :class="{ open: irOpen, disabled: !canEdit }" @click="toggleIr">
            <span class="slot-label tiny">IR</span>
            <span class="faint small">
              {{ irCandidates.length ? 'Empty — tap to add an injured player' : 'Empty — nobody is currently injured' }}
            </span>
            <span v-if="canEdit && irCandidates.length" class="chev faint">›</span>
          </button>

          <div v-if="irOpen" class="picker">
            <div v-if="irCandidates.length === 0" class="empty small">
              Only players listed Out, IR, PUP, Doubtful or Suspended can go here.
            </div>
            <button
              v-for="candidate in irCandidates"
              :key="candidate.id"
              class="candidate"
              :disabled="candidate.locked || irBusy"
              :title="candidate.lockReason || ''"
              @click="placeOnIr(candidate)"
            >
              <PlayerChip :player="candidate" />
            </button>
          </div>
        </template>
      </template>
    </div>

    <div v-if="canEdit" class="card-footer">
      <button class="btn btn-ghost btn-sm" :disabled="!dirty || saving" @click="reset">Reset</button>
      <button class="btn btn-primary btn-sm" :disabled="!dirty || saving" @click="save">
        <span v-if="saving" class="spinner" />
        {{ saving ? 'Saving…' : 'Save lineup' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.slot-group {
  border-bottom: 1px solid var(--border);
}

.slot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 1rem;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
}

.slot:not(.disabled):not(.bench-row):not(.ir-row):hover {
  background: var(--surface);
}

.slot.open {
  background: var(--surface);
}

.slot.disabled {
  cursor: default;
}

.slot-label {
  width: 2.6rem;
  flex-shrink: 0;
  font-weight: 700;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.chev {
  font-size: 1.2rem;
  line-height: 1;
}

/* Bench and IR are records, not buttons — no hover affordance. */
.bench-row,
.ir-row {
  border-bottom: 1px solid var(--border);
  cursor: default;
}

.ir-row {
  background: var(--bg-inset);
}

.ir-empty {
  border-bottom: 1px solid var(--border);
  background: var(--bg-inset);
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 1rem 0.3rem;
  background: var(--bg-inset);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
}

.picker {
  background: var(--bg-inset);
  border-top: 1px solid var(--border);
  max-height: 16rem;
  overflow-y: auto;
}

.candidate {
  display: block;
  width: 100%;
  padding: 0.5rem 1rem 0.5rem 3.6rem;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: inherit;
  text-align: left;
}

.candidate:last-child {
  border-bottom: none;
}

.candidate:hover:not(:disabled) {
  background: var(--surface);
}

.candidate:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.candidate.clear {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.card-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--bg-inset);
}
.title-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
  flex-wrap: wrap;
}

.title-row h2 {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.totals {
  gap: 0.35rem;
}
</style>
