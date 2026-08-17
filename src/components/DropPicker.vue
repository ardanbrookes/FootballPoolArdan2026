<script setup>
/**
 * Modal asking which player to drop when adding someone.
 * Doubles as the "drop candidate" picker for waiver claims, where the choice is
 * mandatory rather than conditional.
 */
import PlayerChip from './PlayerChip.vue'

defineProps({
  open: { type: Boolean, default: false },
  incoming: { type: Object, default: null },
  roster: { type: Object, default: null },
  mode: { type: String, default: 'add' }, // 'add' | 'claim'
  required: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])

const rosterPlayers = (roster) => [
  ...(roster?.starters || []).map((s) => s.player).filter(Boolean),
  ...(roster?.bench || []),
]
</script>

<template>
  <div v-if="open" class="backdrop" @click.self="emit('cancel')">
    <div class="modal card">
      <div class="card-header">
        <h2>{{ mode === 'claim' ? 'Claim' : 'Add' }} {{ incoming?.full_name || incoming?.name }}</h2>
        <button class="btn btn-ghost btn-sm" @click="emit('cancel')">✕</button>
      </div>

      <div class="card-body">
        <p class="small muted" style="margin: 0 0 0.75rem">
          <template v-if="mode === 'claim'">
            Waiver claims need a drop candidate — if the claim is awarded, this player is released.
          </template>
          <template v-else-if="required"> Your roster is full. Choose someone to drop. </template>
          <template v-else> Optionally drop someone to make room. </template>
        </p>

        <button v-if="!required" class="option" :disabled="busy" @click="emit('confirm', null)">
          <span class="bold small">Don't drop anyone</span>
        </button>

        <button
          v-for="player in rosterPlayers(roster)"
          :key="player.id"
          class="option"
          :disabled="player.locked || busy"
          :title="player.lockReason || ''"
          @click="emit('confirm', player.id)"
        >
          <PlayerChip :player="player" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 50;
}

.modal {
  width: 100%;
  max-width: 26rem;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal .card-body {
  overflow-y: auto;
}

.option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.6rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: inherit;
  margin-bottom: 0.4rem;
}

.option:hover:not(:disabled) {
  background: var(--surface);
  border-color: var(--accent);
}

.option:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
