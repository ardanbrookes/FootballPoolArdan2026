<script setup>
/**
 * Head-to-head scoreboard: both starting lineups, slot by slot, with live scores.
 *
 * Built for following along on a Sunday, so a player's score is always shown
 * next to the state of their actual NFL game — a 0.0 means something very
 * different at 1pm than it does at 7pm.
 */
import { computed } from 'vue'

const props = defineProps({
  matchup: { type: Object, required: true },
  myTeamId: { type: [Number, String], default: null },
})

const away = computed(() => props.matchup.away)
const home = computed(() => props.matchup.home)

const homeLeads = computed(() => home.value.total > away.value.total)

const winProb = computed(() => props.matchup.winProbability ?? null)

/** Whichever side belongs to the viewer, so the bar reads from their point of view. */
const mySide = computed(() => {
  if (!winProb.value) return null
  const id = props.myTeamId
  if (home.value.team.id === id) return { pct: winProb.value.home, team: home.value.team, side: 'home' }
  if (away.value.team.id === id) return { pct: winProb.value.away, team: away.value.team, side: 'away' }
  // Spectating someone else's matchup: show it from the home side.
  return { pct: winProb.value.home, team: home.value.team, side: 'home' }
})

const probLabel = computed(() => {
  const wp = winProb.value
  if (!wp || !mySide.value) return ''
  if (wp.settled) return mySide.value.pct >= 100 ? 'Won' : mySide.value.pct <= 0 ? 'Lost' : 'Tied'
  const pct = mySide.value.pct
  // Below 1% still isn't zero, and saying "0%" while the game is live is a lie.
  if (pct > 0 && pct < 1) return '<1% to win'
  if (pct < 100 && pct > 99) return '>99% to win'
  return `${Math.round(pct)}% to win`
})
const awayLeads = computed(() => away.value.total > home.value.total)
const margin = computed(() => Math.abs(home.value.total - away.value.total).toFixed(1))

/** Slots are configured identically for both teams, so index alignment is safe. */
const rows = computed(() =>
  away.value.starters.map((awaySlot, index) => ({
    label: awaySlot.label,
    slot: awaySlot.slot,
    away: awaySlot.player,
    home: home.value.starters[index]?.player ?? null,
  })),
)

/**
 * "Josh Allen" -> "J. Allen", for the narrow mobile column.
 * Team defenses ("DAL D/ST") are left alone — abbreviating them reads as noise.
 */
function shortName(player) {
  if (!player?.name) return ''
  if (player.position === 'DEF') return player.name
  const parts = player.name.split(' ')
  if (parts.length < 2) return player.name
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function statusClass(player) {
  if (!player) return 'is-empty'
  if (player.onBye) return 'is-bye'
  switch (player.game?.status) {
    case 'final':
      return 'is-final'
    case 'in_progress':
      return 'is-live'
    default:
      return 'is-scheduled'
  }
}

function statusLabel(player) {
  if (!player) return ''
  if (player.onBye) return 'BYE'
  if (player.game?.status === 'in_progress') return 'LIVE'
  if (player.game?.status === 'final') return 'FINAL'
  return player.game?.versus ?? ''
}

const progress = (side) => {
  const parts = []
  if (side.inProgress) parts.push(`${side.inProgress} playing`)
  if (side.yetToPlay) parts.push(`${side.yetToPlay} to play`)
  if (!parts.length && side.final) parts.push('all done')
  return parts.join(' · ')
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h2>Your matchup</h2>
      <span v-if="margin !== '0.0'" class="tiny faint">{{ margin }} apart</span>
    </div>

    <div v-if="winProb && mySide" class="winprob">
      <div class="wp-head">
        <span class="wp-pct" :class="{ good: mySide.pct >= 50, bad: mySide.pct < 50 }">
          {{ probLabel }}
        </span>
        <span class="tiny faint">
          projected {{ winProb.projected.away.toFixed(1) }} – {{ winProb.projected.home.toFixed(1) }}
        </span>
      </div>
      <div class="wp-bar" role="img" :aria-label="probLabel">
        <div class="wp-fill" :class="{ good: mySide.pct >= 50 }" :style="{ width: mySide.pct + '%' }" />
      </div>
      <div class="tiny faint wp-note">
        From projected points and how much each position usually swings. A rough guide, not a
        prediction.
      </div>
    </div>

    <div class="scoreline">
      <div class="team-side" :class="{ leading: awayLeads, mine: away.team.id === myTeamId }">
        <div class="team-name">{{ away.team.name }}</div>
        <div class="tiny faint">{{ away.team.wins }}-{{ away.team.losses }}-{{ away.team.ties }}</div>
        <div class="total mono">{{ away.total.toFixed(1) }}</div>
        <div class="tiny faint">{{ progress(away) }}</div>
      </div>

      <div class="versus tiny faint">vs</div>

      <div class="team-side" :class="{ leading: homeLeads, mine: home.team.id === myTeamId }">
        <div class="team-name">{{ home.team.name }}</div>
        <div class="tiny faint">{{ home.team.wins }}-{{ home.team.losses }}-{{ home.team.ties }}</div>
        <div class="total mono">{{ home.total.toFixed(1) }}</div>
        <div class="tiny faint">{{ progress(home) }}</div>
      </div>
    </div>

    <div class="rows">
      <div v-for="row in rows" :key="row.slot" class="matchup-row">
        <div class="player left" :class="statusClass(row.away)">
          <template v-if="row.away">
            <div class="name">
              <span class="full">{{ row.away.name }}</span>
              <span class="short">{{ shortName(row.away) }}</span>
            </div>
            <div class="meta tiny">
              <span class="status">{{ statusLabel(row.away) }}</span>
              <span v-if="row.away.injuryStatus" class="inj">{{ row.away.injuryStatus }}</span>
            </div>
          </template>
          <div v-else class="name faint">—</div>
        </div>

        <div class="pts left mono" :class="statusClass(row.away)">
          {{ row.away ? row.away.points.toFixed(1) : '—' }}
        </div>

        <div class="slot tiny">{{ row.label }}</div>

        <div class="pts right mono" :class="statusClass(row.home)">
          {{ row.home ? row.home.points.toFixed(1) : '—' }}
        </div>

        <div class="player right" :class="statusClass(row.home)">
          <template v-if="row.home">
            <div class="name">
              <span class="full">{{ row.home.name }}</span>
              <span class="short">{{ shortName(row.home) }}</span>
            </div>
            <div class="meta tiny">
              <span v-if="row.home.injuryStatus" class="inj">{{ row.home.injuryStatus }}</span>
              <span class="status">{{ statusLabel(row.home) }}</span>
            </div>
          </template>
          <div v-else class="name faint">—</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scoreline {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border);
}

.team-side {
  min-width: 0;
}

.team-side:last-child {
  text-align: right;
}

.team-name {
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.team-side.mine .team-name {
  color: var(--accent-hover);
}

.total {
  font-size: 1.7rem;
  font-weight: 600;
  line-height: 1.15;
  color: var(--text-muted);
}

.team-side.leading .total {
  color: var(--text);
}

.versus {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.rows {
  display: flex;
  flex-direction: column;
}

.matchup-row {
  display: grid;
  grid-template-columns: 1fr 3rem 3rem 3rem 1fr;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 1rem;
  border-bottom: 1px solid var(--border);
}

.matchup-row:last-child {
  border-bottom: none;
}

.player {
  min-width: 0;
}

.player.right {
  text-align: right;
}

.name {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Full names on desktop, "J. Allen" once the column gets tight. */
.name .short {
  display: none;
}

.meta {
  display: flex;
  gap: 0.35rem;
  color: var(--text-faint);
}

.player.right .meta {
  justify-content: flex-end;
}

.inj {
  color: var(--danger);
}

.slot {
  text-align: center;
  font-weight: 700;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pts {
  font-size: 0.9rem;
  font-weight: 600;
  text-align: right;
}

.pts.right {
  text-align: left;
}

/* A score reads differently depending on whether the game has happened. */
.is-scheduled .name,
.is-scheduled.pts {
  color: var(--text-faint);
}

.is-final .name {
  color: var(--text);
}

.is-final.pts {
  color: var(--text);
}

.is-live .name {
  color: var(--text);
}

.is-live.pts {
  color: var(--accent-hover);
}

.is-live .status {
  color: var(--accent-hover);
  font-weight: 700;
}

.is-bye .name,
.is-bye.pts {
  color: var(--text-faint);
  opacity: 0.6;
}

.is-bye .status {
  color: var(--warn);
  font-weight: 700;
}

@media (max-width: 640px) {
  .matchup-row {
    grid-template-columns: 1fr 2.5rem 2.2rem 2.5rem 1fr;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    gap: 0.2rem;
  }

  .name .full {
    display: none;
  }

  .name .short {
    display: inline;
  }

  .name {
    font-size: 0.8rem;
  }

  .pts {
    font-size: 0.85rem;
  }

  .total {
    font-size: 1.35rem;
  }
}
.winprob {
  padding: 0.6rem 0.85rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.wp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.35rem;
}

.wp-pct {
  font-size: 0.95rem;
  font-weight: 700;
}

.wp-pct.good {
  color: var(--accent-hover);
}

.wp-pct.bad {
  color: var(--warn);
}

.wp-bar {
  height: 0.4rem;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: hidden;
}

.wp-fill {
  height: 100%;
  background: var(--warn);
  transition: width 0.4s ease;
}

.wp-fill.good {
  background: var(--accent);
}

.wp-note {
  margin-top: 0.35rem;
}
</style>
