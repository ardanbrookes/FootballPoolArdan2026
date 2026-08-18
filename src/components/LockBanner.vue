<script setup>
/**
 * Explains, in plain language, what the current lock phase means for the
 * manager right now — the single most confusing part of the league rules.
 */
import { computed } from 'vue'

const props = defineProps({
  lockState: { type: Object, default: null },
})

const tone = computed(() => {
  switch (props.lockState?.phase) {
    case 'blanket_lock':
      return 'alert-error'
    case 'early_game_lock':
      return 'alert-warn'
    case 'waiver_period':
      return 'alert-info'
    default:
      return 'alert-success'
  }
})

/**
 * The headline answers the only question that actually matters on this page:
 * can I pick someone up right now, or can I only queue a claim?
 *
 * The phase name alone ("Waiver period") didn't say that — you had to know the
 * rules to translate it.
 */
const headline = computed(() => {
  const state = props.lockState
  if (!state) return ''
  return state.allows?.freeAgentAdd
    ? 'Unrostered players are FREE AGENTS — add them instantly, first come first served.'
    : 'Unrostered players are ON WAIVERS — you can only submit a claim, which resolves at the next processing run.'
})

const detail = computed(() => {
  const state = props.lockState
  if (!state) return ''
  const locked = state.lockedNflTeams || []

  switch (state.phase) {
    case 'preseason':
      return 'The season hasn\'t started, so there are no waivers yet. Free agency stays open until the first Sunday lock.'
    case 'waiver_period':
      return 'Rosters and trades are open. Claims process Tuesday 3:00 AM.'
    case 'open':
      return 'Adds, drops, swaps and lineup changes are all available.'
    case 'early_game_lock':
      return locked.length
        ? `Thursday night lock — only ${locked.join(' and ')} are frozen. Everyone else stays open until Sunday.`
        : 'Thursday night lock is in effect for the teams already playing.'
    case 'blanket_lock':
      return 'Rosters are frozen and trades are closed until the last game of the week finishes. You can still queue claims.'
    default:
      return ''
  }
})
</script>

<template>
  <div v-if="lockState" class="alert" :class="tone">
    <div class="headline">
      <span class="pill" :class="lockState.allows?.freeAgentAdd ? 'pill-accent' : 'pill-warn'">
        {{ lockState.allows?.freeAgentAdd ? 'FREE AGENCY OPEN' : 'WAIVERS ONLY' }}
      </span>
      <strong>{{ headline }}</strong>
    </div>
    <div class="small detail">{{ lockState.phaseLabel }} — {{ detail }}</div>
    <div v-if="lockState.weekDrift" class="tiny drift">
      Heads up: the league is on week {{ lockState.weekDrift.leagueWeek }} but the NFL schedule says week
      {{ lockState.weekDrift.scheduleWeek }}. Locks follow the schedule.
    </div>
  </div>
</template>

<style scoped>
.headline {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.headline .pill {
  flex-shrink: 0;
}

.detail {
  margin-top: 0.3rem;
  opacity: 0.85;
}

.drift {
  margin-top: 0.4rem;
  opacity: 0.85;
}
</style>
