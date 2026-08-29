<script setup>
/**
 * Rename your own team, in place.
 *
 * No phase restrictions — a team name touches nothing that scoring or locks
 * care about, so there is no reason to close it on a Sunday. The rename is
 * announced in chat so the league can follow who is now called what.
 */
import { ref, nextTick, watch } from 'vue'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'

const props = defineProps({
  team: { type: Object, default: null },
})
const emit = defineEmits(['renamed'])

const league = useLeagueStore()

const editing = ref(false)
const draft = ref('')
const saving = ref(false)
const error = ref(null)
const input = ref(null)

async function open() {
  draft.value = props.team?.name ?? ''
  error.value = null
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function cancel() {
  editing.value = false
  error.value = null
}

async function save() {
  const name = draft.value.trim()
  if (!name || name === props.team?.name) return cancel()

  saving.value = true
  error.value = null
  try {
    const result = await api.renameTeam(name)
    editing.value = false
    // The name shows in the top bar and on every scoreboard, so refresh the
    // store rather than patching one copy of it.
    await league.load()
    emit('renamed', result)
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
  }
}

// Close the editor if the team changes underneath us (e.g. a store refresh).
watch(() => props.team?.id, cancel)
</script>

<template>
  <span class="wrap">
    <template v-if="!editing">
      <button class="rename" type="button" title="Rename your team" @click="open">
        ✎ <span class="label">Rename</span>
      </button>
    </template>

    <template v-else>
      <input
        ref="input"
        v-model="draft"
        class="name-input"
        maxlength="32"
        :disabled="saving"
        aria-label="Team name"
        @keyup.enter="save"
        @keyup.esc="cancel"
      />
      <button class="btn btn-primary btn-sm" type="button" :disabled="saving" @click="save">
        {{ saving ? '…' : 'Save' }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="saving" @click="cancel">
        Cancel
      </button>
    </template>

    <span v-if="error" class="tiny err">{{ error }}</span>
  </span>
</template>

<style scoped>
.wrap {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  min-width: 0;
}

.rename {
  padding: 0.15rem 0.4rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-faint);
  font-size: 0.75rem;
  cursor: pointer;
}

.rename:hover {
  border-color: var(--border);
  color: var(--text);
}

.name-input {
  width: min(12rem, 42vw);
  min-width: 0;
  padding: 0.2rem 0.4rem;
  font-size: 0.85rem;
}

.err {
  color: var(--danger);
}

@media (max-width: 620px) {
  /* The pencil is enough on a phone; the word costs a line break. */
  .label {
    display: none;
  }
}
</style>
