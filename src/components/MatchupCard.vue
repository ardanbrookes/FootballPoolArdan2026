<script setup>
import { computed } from 'vue'

const props = defineProps({
  matchup: { type: Object, required: true },
  myTeamId: { type: [Number, String], default: null },
})

const homeLeads = computed(() => props.matchup.home_score > props.matchup.away_score)
const awayLeads = computed(() => props.matchup.away_score > props.matchup.home_score)
const isMine = computed(
  () => props.matchup.home_id === props.myTeamId || props.matchup.away_id === props.myTeamId,
)
</script>

<template>
  <div class="matchup" :class="{ mine: isMine }">
    <div class="side" :class="{ leading: awayLeads }">
      <div class="team">
        <span class="abbr mono">{{ matchup.away_abbr }}</span>
        <span class="name">{{ matchup.away_name }}</span>
      </div>
      <div class="record tiny faint">
        {{ matchup.away_wins }}-{{ matchup.away_losses }}-{{ matchup.away_ties }}
      </div>
      <div class="score mono">{{ matchup.away_score.toFixed(1) }}</div>
    </div>

    <div class="divider">
      <span class="tiny faint">{{ matchup.status === 'final' ? 'FINAL' : 'vs' }}</span>
    </div>

    <div class="side" :class="{ leading: homeLeads }">
      <div class="team">
        <span class="abbr mono">{{ matchup.home_abbr }}</span>
        <span class="name">{{ matchup.home_name }}</span>
      </div>
      <div class="record tiny faint">
        {{ matchup.home_wins }}-{{ matchup.home_losses }}-{{ matchup.home_ties }}
      </div>
      <div class="score mono">{{ matchup.home_score.toFixed(1) }}</div>
    </div>
  </div>
</template>

<style scoped>
.matchup {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  padding: 0.5rem 0.75rem;
}

.matchup.mine {
  border-color: var(--accent);
}

.side {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.3rem 0;
}

.team {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.abbr {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-faint);
  width: 2.5rem;
  flex-shrink: 0;
}

.name {
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.score {
  font-size: 1rem;
  font-weight: 600;
  min-width: 3rem;
  text-align: right;
  color: var(--text-muted);
}

.leading .score,
.leading .name {
  color: var(--text);
}

.leading .score {
  color: var(--accent-hover);
}

.divider {
  border-top: 1px solid var(--border);
  text-align: center;
  margin: 0.15rem 0;
  line-height: 0;
}

.divider span {
  background: var(--bg-raised);
  padding: 0 0.5rem;
  letter-spacing: 0.08em;
}
</style>
