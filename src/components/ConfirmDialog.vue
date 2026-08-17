<script setup>
/**
 * Confirmation prompt for actions that can't be undone.
 *
 * Deliberately spells out the consequence rather than just asking "are you
 * sure?" — a dropped player goes to waivers, not straight back to free agency,
 * so anyone in the league can claim them before you could take them back.
 */
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Are you sure?' },
  message: { type: String, default: '' },
  detail: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  cancelLabel: { type: String, default: 'Cancel' },
  destructive: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <div v-if="open" class="backdrop" @click.self="emit('cancel')">
    <div class="modal card" role="dialog" aria-modal="true">
      <div class="card-header">
        <h2>{{ title }}</h2>
      </div>

      <div class="card-body">
        <p class="message">{{ message }}</p>
        <p v-if="detail" class="small muted detail">{{ detail }}</p>
      </div>

      <div class="actions">
        <button class="btn btn-sm" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button
          class="btn btn-sm"
          :class="destructive ? 'btn-danger-solid' : 'btn-primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? 'Working…' : confirmLabel }}
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
  z-index: 60;
}

.modal {
  width: 100%;
  max-width: 24rem;
}

.message {
  margin: 0;
  font-size: 0.9rem;
}

.detail {
  margin: 0.5rem 0 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--bg-inset);
}

.btn-danger-solid {
  background: var(--danger);
  border-color: var(--danger);
  color: #1a0505;
  font-weight: 600;
}

.btn-danger-solid:hover:not(:disabled) {
  background: #ef6a6a;
  border-color: #ef6a6a;
}
</style>
