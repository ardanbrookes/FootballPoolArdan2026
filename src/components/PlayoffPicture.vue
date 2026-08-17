<script setup>
/**
 * Playoff picture.
 *
 * Regular season: the race for the four spots — who's in, who's chasing, who's
 * out. From week 15: the bracket itself, semifinals then final.
 */
import { computed } from 'vue'

const props = defineProps({
  playoffs: { type: Object, required: true },
  myTeamId: { type: [Number, String], default: null },
})

const bracket = computed(() => props.playoffs.bracket)
const spots = computed(() => props.playoffs.spots)

const contenders = computed(() => props.playoffs.seeds.slice(0, spots.value))
const chasing = computed(() => props.playoffs.seeds.slice(spots.value))

const statusPill = (status) => {
  switch (status) {
    case 'clinched':
      return { text: 'clinched', cls: 'pill-accent' }
    case 'in':
      return { text: 'in the spots', cls: 'pill-accent' }
    case 'hunting':
      return { text: 'in the hunt', cls: 'pill-warn' }
    case 'eliminated':
      return { text: 'eliminated', cls: 'pill-danger' }
    default:
      return { text: '', cls: '' }
  }
}

const record = (t) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`

const sideClass = (matchup, side) => ({
  won: matchup.status === 'final' && matchup.winnerTeamId === side.teamId,
  lost: matchup.status === 'final' && matchup.winnerTeamId !== side.teamId,
  mine: side.teamId === props.myTeamId,
})
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h2>{{ playoffs.inPlayoffs ? 'Playoff bracket' : 'Playoff picture' }}</h2>
      <span class="tiny faint">
        <template v-if="playoffs.inPlayoffs">
          Weeks {{ playoffs.playoffWeeks.join(' & ') }} · single elimination
        </template>
        <template v-else>
          Top {{ spots }} after {{ playoffs.regularSeasonWeeks }} weeks ·
          {{ playoffs.weeksRemaining }} to play
        </template>
      </span>
    </div>

    <!-- Bracket -->
    <div v-if="bracket" class="card-body">
      <div v-if="bracket.champion" class="alert alert-success champ-banner">
        <strong>{{ bracket.champion.name }}</strong> wins the championship.
      </div>

      <div class="bracket">
        <div v-for="round in bracket.rounds" :key="round.week" class="round">
          <div class="round-label tiny">{{ round.name }} · wk {{ round.week }}</div>

          <div v-if="round.matchups.length === 0" class="tbd small faint">
            {{ bracket.semifinalsComplete ? 'Being set…' : 'Awaiting semifinal winners' }}
          </div>

          <div v-for="m in round.matchups" :key="m.id" class="bmatch">
            <div v-for="side in [m.home, m.away]" :key="side.teamId" class="bside" :class="sideClass(m, side)">
              <span class="bseed mono">{{ side.seed ? `#${side.seed}` : '—' }}</span>
              <span class="bname">{{ side.name }}</span>
              <span class="bscore mono">{{ m.status === 'final' ? side.score.toFixed(1) : '—' }}</span>
            </div>
            <div v-if="m.status !== 'final'" class="bstatus tiny faint">
              {{ m.status === 'in_progress' ? 'in progress' : 'scheduled' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Regular season race -->
    <div v-else class="card-body flush">
      <div class="seed-group">
        <div class="group-label tiny">Playoff spots · top {{ spots }}</div>
        <div v-for="team in contenders" :key="team.id" class="seed-row in" :class="{ mine: team.id === myTeamId }">
          <span class="seed-num mono">{{ team.seed }}</span>
          <div class="seed-team">
            <div class="small bold">{{ team.name }}</div>
            <div class="tiny faint">{{ team.manager }}</div>
          </div>
          <span class="mono small rec">{{ record(team) }}</span>
          <span class="mono tiny faint pf">{{ team.points_for.toFixed(1) }}</span>
          <span class="pill" :class="statusPill(team.status).cls">{{ statusPill(team.status).text }}</span>
        </div>
      </div>

      <div class="seed-group">
        <div class="group-label tiny">Chasing</div>
        <div v-for="team in chasing" :key="team.id" class="seed-row" :class="{ mine: team.id === myTeamId }">
          <span class="seed-num mono faint">{{ team.seed }}</span>
          <div class="seed-team">
            <div class="small">{{ team.name }}</div>
            <div class="tiny faint">{{ team.manager }}</div>
          </div>
          <span class="mono small rec">{{ record(team) }}</span>
          <span class="mono tiny faint pf">{{ team.points_for.toFixed(1) }}</span>
          <span class="pill" :class="statusPill(team.status).cls">
            {{ statusPill(team.status).text
            }}<template v-if="team.status === 'hunting' && team.gamesBack > 0">
              · {{ team.gamesBack }} back</template>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.champ-banner {
  margin-bottom: 1rem;
}

.bracket {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.round-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
  margin-bottom: 0.4rem;
}

.bmatch {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
}

.bmatch:last-child {
  margin-bottom: 0;
}

.bside {
  display: grid;
  grid-template-columns: 2rem 1fr auto;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.15rem 0;
}

.bseed {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-faint);
}

.bname {
  font-size: 0.85rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bscore {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.bside.won .bname,
.bside.won .bscore {
  color: var(--accent-hover);
  font-weight: 600;
}

.bside.lost .bname,
.bside.lost .bscore {
  opacity: 0.55;
}

.bside.mine .bname {
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}

.bstatus {
  padding-top: 0.2rem;
  border-top: 1px solid var(--border);
  margin-top: 0.25rem;
}

.tbd {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
  text-align: center;
}

/* ---- regular season race ---- */

.seed-group + .seed-group {
  border-top: 1px solid var(--border);
}

.group-label {
  padding: 0.5rem 1rem 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
  background: var(--bg-inset);
}

.seed-row {
  display: grid;
  grid-template-columns: 1.75rem 1fr auto auto auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 1rem;
  border-bottom: 1px solid var(--border);
}

.seed-row:last-child {
  border-bottom: none;
}

.seed-row.mine {
  background: var(--accent-soft);
}

.seed-num {
  font-weight: 700;
  text-align: center;
  color: var(--text-muted);
}

.seed-row.in .seed-num {
  color: var(--accent-hover);
}

.seed-team {
  min-width: 0;
}

.pf {
  min-width: 3.5rem;
  text-align: right;
}

@media (max-width: 700px) {
  .bracket {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 620px) {
  /* Points-for is the one column worth losing on a phone — the status pill is
     the whole reason this view exists, so it stays. */
  .seed-row {
    grid-template-columns: 1.4rem 1fr auto auto;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
  }

  .pf {
    display: none;
  }

  .seed-row .pill {
    font-size: 0.62rem;
    padding: 0.1rem 0.35rem;
  }

  .rec {
    font-size: 0.78rem;
  }

  .group-label {
    padding-left: 0.7rem;
  }
}
</style>
