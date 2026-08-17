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

const message = computed(() => {
  const state = props.lockState
  if (!state) return ''
  const locked = state.lockedNflTeams || []

  switch (state.phase) {
    case 'waiver_period':
      return 'Waiver period — everyone unrostered is on waivers. Submit claims instead of instant pickups. Lineups are open.'
    case 'open':
      return 'Open window — adds, drops, swaps and lineup changes are all available, first come first served.'
    case 'early_game_lock':
      return locked.length
        ? `Thursday night lock — only ${locked.join(' and ')} are frozen. Everyone else stays open until Sunday.`
        : 'Thursday night lock is in effect for the teams already playing.'
    case 'blanket_lock':
      return 'All rosters are locked, including bench moves, until the week resets on Sunday night.'
    default:
      return ''
  }
})
</script>

<template>
  <div v-if="lockState" class="alert" :class="tone">
    <div class="row-between">
      <span><strong>{{ lockState.phaseLabel }}.</strong> {{ message }}</span>
    </div>
    <div v-if="lockState.weekDrift" class="tiny" style="margin-top: 0.4rem; opacity: 0.85">
      Heads up: the league is on week {{ lockState.weekDrift.leagueWeek }} but the NFL schedule says week
      {{ lockState.weekDrift.scheduleWeek }}. Locks follow the schedule.
    </div>
  </div>
</template>
