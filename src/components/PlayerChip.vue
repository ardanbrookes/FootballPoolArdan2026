<script setup>
/** Compact player identity: position pill, name, team/bye, injury flag. */
import { computed } from 'vue'

const props = defineProps({
  player: { type: Object, required: true },
  showPoints: { type: Boolean, default: false },
})

/**
 * "Questionable" costs ~80px next to a name that already needs truncating on a
 * phone. The single-letter forms are the fantasy convention and read fine.
 */
const INJURY_SHORT = {
  Questionable: 'Q',
  Doubtful: 'D',
  Out: 'O',
  'Injured Reserve': 'IR',
  IR: 'IR',
  PUP: 'PUP',
  Suspended: 'SUS',
  COV: 'COV',
  DNR: 'DNR',
  NA: 'NA',
}

const injury = computed(() => props.player.injuryStatus || props.player.injury_status || null)
const injuryShort = computed(() => (injury.value ? INJURY_SHORT[injury.value] ?? injury.value : null))
</script>

<template>
  <div class="chip" :class="{ locked: player.locked }">
    <span class="pill pill-pos" :class="`pos-${player.position}`">{{ player.position }}</span>
    <div class="chip-main">
      <div class="chip-name">
        <span class="nm">{{ player.name || player.full_name }}</span>
        <span v-if="injury" class="pill pill-danger tiny inj" :title="injury">
          <span class="full">{{ injury }}</span>
          <span class="short">{{ injuryShort }}</span>
        </span>
        <span v-if="player.locked" class="pill pill-warn tiny" :title="player.lockReason">locked</span>
      </div>
      <div class="chip-meta tiny faint">
        {{ player.nflTeam || player.nfl_team || 'FA' }}
        <template v-if="player.byeWeek || player.bye_week">· bye {{ player.byeWeek || player.bye_week }}</template>
      </div>
    </div>
    <div v-if="showPoints" class="chip-points mono">{{ (player.points ?? 0).toFixed(1) }}</div>
  </div>
</template>

<style scoped>
.chip {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  /* Both are needed: min-width lets the chip shrink inside a flex row, and
     flex:1 stops it claiming more than its share of a narrow one. */
  min-width: 0;
  flex: 1 1 auto;
}

.chip-main {
  min-width: 0;
  flex: 1;
}

.chip-name {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-weight: 500;
  font-size: 0.875rem;
  min-width: 0;
}

/* The name truncates; the flags beside it never shrink away. */
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.inj {
  flex-shrink: 0;
}

.inj .short {
  display: none;
}

@media (max-width: 620px) {
  .inj .full {
    display: none;
  }

  .inj .short {
    display: inline;
  }
}

.chip-points {
  font-weight: 600;
  font-size: 0.9rem;
}
</style>
