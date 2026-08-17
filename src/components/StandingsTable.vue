<script setup>
/**
 * League standings.
 *
 * `compact` is the sidebar version on Home. `detailed` adds manager, win pct,
 * points against and differential — enough columns to fill a full-width layout
 * instead of leaving the table stranded in whitespace.
 */
import { computed } from 'vue'

const props = defineProps({
  standings: { type: Array, default: () => [] },
  highlightTeamId: { type: [Number, String], default: null },
  compact: { type: Boolean, default: false },
  detailed: { type: Boolean, default: false },
  /** Rows at or above this index are in the championship spots. */
  playoffSpots: { type: Number, default: 0 },
})

const rows = computed(() =>
  props.standings.map((team, index) => {
    const games = team.wins + team.losses + team.ties
    return {
      ...team,
      rank: index + 1,
      winPct: games ? (team.wins + team.ties * 0.5) / games : 0,
      diff: team.points_for - team.points_against,
      inPlayoffs: props.playoffSpots > 0 && index < props.playoffSpots,
    }
  }),
)

const pct = (value) => value.toFixed(3).replace(/^0/, '')
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th style="width: 2.5rem">#</th>
          <th>Team</th>
          <th v-if="detailed" class="col-manager">Manager</th>
          <th class="num">W-L-T</th>
          <th v-if="detailed" class="num col-pct">Pct</th>
          <th class="num">PF</th>
          <th v-if="!compact" class="num col-pa">PA</th>
          <th v-if="detailed" class="num col-diff">Diff</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="team in rows"
          :key="team.id"
          :class="{ mine: team.id === highlightTeamId, cutoff: playoffSpots > 0 && team.rank === playoffSpots }"
        >
          <td class="mono rank" :class="{ inPlayoffs: team.inPlayoffs }">{{ team.rank }}</td>
          <td>
            <div class="bold">{{ team.name }}</div>
            <div v-if="!compact && !detailed" class="tiny faint">{{ team.manager || 'Unclaimed' }}</div>
          </td>
          <td v-if="detailed" class="faint small col-manager">{{ team.manager || 'Unclaimed' }}</td>
          <td class="num mono">{{ team.wins }}-{{ team.losses }}-{{ team.ties }}</td>
          <td v-if="detailed" class="num mono faint col-pct">{{ pct(team.winPct) }}</td>
          <td class="num mono">{{ team.points_for.toFixed(1) }}</td>
          <td v-if="!compact" class="num mono faint col-pa">{{ team.points_against.toFixed(1) }}</td>
          <td v-if="detailed" class="num mono col-diff" :class="team.diff >= 0 ? 'pos' : 'neg'">
            {{ team.diff >= 0 ? '+' : '' }}{{ team.diff.toFixed(1) }}
          </td>
        </tr>
        <tr v-if="rows.length === 0">
          <td colspan="8" class="empty">No standings yet.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
tr.mine {
  background: var(--accent-soft);
}
tr.mine:hover {
  background: var(--accent-soft);
}

/* A hairline under the last qualifying team makes the cut obvious at a glance. */
tr.cutoff td {
  border-bottom: 2px solid var(--accent);
}

.rank.inPlayoffs {
  color: var(--accent-hover);
  font-weight: 700;
}

.pos {
  color: var(--accent-hover);
}

.neg {
  color: var(--danger);
}

/* Shed columns rather than let the table force the page to scroll sideways.
   Order of sacrifice: manager, then differential, then points-against —
   record and points-for are what people actually read. */
@media (max-width: 820px) {
  .col-manager,
  .col-diff {
    display: none;
  }
}

@media (max-width: 620px) {
  .col-pct,
  .col-pa {
    display: none;
  }

  th,
  td {
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
}
</style>
