<script setup>
/**
 * The week in numbers, under last week's results.
 *
 * Every line is a pair — a best and a worst — because that's what people
 * actually compare, and a single "highest score" on its own tells you nothing
 * about how the rest of the league did.
 */
import { computed } from 'vue'

const props = defineProps({
  recap: { type: Object, required: true },
  myTeamId: { type: [Number, String], default: null },
})

const s = computed(() => props.recap.sections)

const signed = (n) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1))

/**
 * The pairs, built here rather than in the template: each is the same shape,
 * and a null half (no previous week to compare against) drops out cleanly.
 */
const pairs = computed(() => {
  const out = []
  const push = (label, good, bad) => {
    if (good && bad) out.push({ label, good, bad })
  }

  push(
    'Manager of the week',
    s.value.managers.best && {
      title: 'Best',
      name: s.value.managers.best.name,
      value: `${s.value.managers.best.leftOnBench.toFixed(1)} left on bench`,
      teamId: s.value.managers.best.teamId,
    },
    s.value.managers.worst && {
      title: 'Worst',
      name: s.value.managers.worst.name,
      value: `${s.value.managers.worst.leftOnBench.toFixed(1)} left on bench`,
      teamId: s.value.managers.worst.teamId,
    },
  )

  push(
    'Margins',
    s.value.blowouts.biggest && {
      title: 'Biggest blowout',
      name: s.value.blowouts.biggest.winner,
      value: `by ${s.value.blowouts.biggest.margin.toFixed(1)}`,
    },
    s.value.blowouts.closest && {
      title: 'Closest game',
      name: s.value.blowouts.closest.tie ? 'Tied' : s.value.blowouts.closest.winner,
      value: s.value.blowouts.closest.tie
        ? 'dead level'
        : `by ${s.value.blowouts.closest.margin.toFixed(1)}`,
    },
  )

  push(
    'Scoring',
    s.value.scoring.highest && {
      title: 'Highest',
      name: s.value.scoring.highest.name,
      value: s.value.scoring.highest.points.toFixed(1),
      teamId: s.value.scoring.highest.teamId,
    },
    s.value.scoring.lowest && {
      title: 'Lowest',
      name: s.value.scoring.lowest.name,
      value: s.value.scoring.lowest.points.toFixed(1),
      teamId: s.value.scoring.lowest.teamId,
    },
  )

  // Projections run hot, so a whole league can miss them in the same week.
  // Calling the least-bad team an overperformer would be a lie, so the label
  // follows the sign.
  push(
    'Against projection',
    s.value.projection.over && {
      title: s.value.projection.over.vsProjection >= 0 ? 'Overperformed' : 'Closest to projection',
      name: s.value.projection.over.name,
      value: signed(s.value.projection.over.vsProjection),
      teamId: s.value.projection.over.teamId,
    },
    s.value.projection.under && {
      title: 'Underperformed',
      name: s.value.projection.under.name,
      value: signed(s.value.projection.under.vsProjection),
      teamId: s.value.projection.under.teamId,
    },
  )

  if (s.value.momentum.bounceBack?.change != null) {
    push(
      'Since last week',
      {
        // Sign-neutral: in a week where everyone fell, 'bounce back' would be wrong.
        title: s.value.momentum.bounceBack.change >= 0 ? 'Bounce back' : 'Smallest drop',
        name: s.value.momentum.bounceBack.name,
        value: signed(s.value.momentum.bounceBack.change),
        teamId: s.value.momentum.bounceBack.teamId,
      },
      {
        title: s.value.momentum.falloff.change <= 0 ? 'Fall off' : 'Smallest gain',
        name: s.value.momentum.falloff.name,
        value: signed(s.value.momentum.falloff.change),
        teamId: s.value.momentum.falloff.teamId,
      },
    )
  }

  push(
    'Players',
    s.value.players.overachiever && {
      title: 'Overachiever',
      name: s.value.players.overachiever.name,
      sub: `${s.value.players.overachiever.team} · ${s.value.players.overachiever.points.toFixed(1)} pts`,
      value: signed(s.value.players.overachiever.diff),
    },
    s.value.players.bust && {
      title: 'Bust',
      name: s.value.players.bust.name,
      sub: `${s.value.players.bust.team} · ${s.value.players.bust.points.toFixed(1)} pts`,
      value: signed(s.value.players.bust.diff),
    },
  )

  return out
})

const odds = computed(() => props.recap.playoffOdds ?? [])
const settled = computed(() => odds.value.some((t) => t.settled))
</script>

<template>
  <div class="recap">
    <div class="recap-head tiny">Week {{ recap.week }} in numbers</div>

    <div class="recap-grid">
      <div v-for="pair in pairs" :key="pair.label" class="pair">
        <div class="pair-label tiny faint">{{ pair.label }}</div>
        <div class="pair-body">
          <div v-for="side in [pair.good, pair.bad]" :key="side.title" class="side">
            <div class="tiny faint">{{ side.title }}</div>
            <div class="small bold name" :class="{ mine: side.teamId && side.teamId === myTeamId }">
              {{ side.name }}
            </div>
            <div v-if="side.sub" class="tiny faint">{{ side.sub }}</div>
            <div class="mono value">{{ side.value }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="odds.length" class="odds">
      <div class="pair-label tiny faint">
        Playoff odds
        <span v-if="!settled" class="faint">
          — simulated from today's rosters and the remaining schedule
        </span>
      </div>
      <div v-for="team in odds" :key="team.teamId" class="odds-row">
        <span class="mono tiny abbr">{{ team.abbreviation }}</span>
        <span class="small tname" :class="{ mine: team.teamId === myTeamId }">{{ team.name }}</span>
        <span class="tiny faint rec">{{ team.wins }}-{{ team.losses }}-{{ team.ties }}</span>
        <span class="bar"><span class="fill" :style="{ width: Math.max(1, team.odds) + '%' }" /></span>
        <span class="mono tiny pct">{{ team.odds }}%</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recap {
  border-top: 1px solid var(--border);
  margin-top: 1rem;
  padding-top: 0.85rem;
}

.recap-head {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-faint);
  margin-bottom: 0.6rem;
}

.recap-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

@media (max-width: 1100px) {
  .recap-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .recap-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.pair {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.6rem;
}

.pair-label {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  margin-bottom: 0.35rem;
}

.pair-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.5rem;
}

.side {
  min-width: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name.mine,
.tname.mine {
  color: var(--accent-hover);
}

.value {
  font-size: 0.9rem;
  font-weight: 600;
  margin-top: 0.1rem;
}

.odds {
  margin-top: 0.85rem;
}

.odds-row {
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr) 3.2rem minmax(3rem, 8rem) 2.8rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.18rem 0;
}

.abbr {
  color: var(--text-faint);
  font-weight: 700;
}

.tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 0.4rem;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.pct {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 620px) {
  .odds-row {
    grid-template-columns: 2.2rem minmax(0, 1fr) 3rem 2.6rem;
  }

  .bar {
    display: none;
  }
}
</style>
