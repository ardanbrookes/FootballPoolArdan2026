<script setup>
/**
 * Countdown to the next roster deadline.
 * Ticks locally and asks the store to re-check the phase when it hits zero.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps({
  deadline: { type: Object, default: null }, // { name, title, label, at }
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['elapsed'])

const remaining = ref(0)
let timer

function tick() {
  if (!props.deadline?.at) {
    remaining.value = 0
    return
  }
  const next = Math.max(0, Date.parse(props.deadline.at) - Date.now())
  const wasPositive = remaining.value > 0
  remaining.value = next
  if (wasPositive && next === 0) emit('elapsed')
}

onMounted(() => {
  tick()
  timer = setInterval(tick, 1000)
})
onUnmounted(() => clearInterval(timer))
watch(() => props.deadline?.at, tick)

const parts = computed(() => {
  const total = Math.floor(remaining.value / 1000)
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
})

const urgent = computed(() => remaining.value > 0 && remaining.value < 3 * 3600 * 1000)
const pad = (n) => String(n).padStart(2, '0')
</script>

<template>
  <div v-if="deadline" class="timer" :class="{ urgent, compact }">
    <div class="timer-label">{{ deadline.title }}</div>
    <div class="timer-value mono">
      <template v-if="remaining > 0">
        <span v-if="parts.days">{{ parts.days }}d </span>{{ pad(parts.hours) }}:{{ pad(parts.minutes) }}:{{
          pad(parts.seconds)
        }}
      </template>
      <template v-else>now</template>
    </div>
    <div v-if="!compact" class="timer-when tiny faint">{{ deadline.label }}</div>
  </div>
</template>

<style scoped>
.timer {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.timer-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  font-weight: 600;
}

.timer-value {
  font-size: 1.6rem;
  font-weight: 600;
  line-height: 1.1;
  color: var(--text);
}

.compact .timer-value {
  font-size: 1rem;
}

.urgent .timer-value {
  color: var(--warn);
}
</style>
