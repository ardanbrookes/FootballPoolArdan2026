<script setup>
/**
 * League — one page instead of four tabs.
 *
 * Schedule and Results were the same rows viewed twice (a matchup becomes a
 * result once it's final), so they're merged into a single week-by-week section
 * with a week picker. Standings, playoff picture and rosters stack below, each
 * laid out to use the full container width rather than sitting in a narrow
 * column with whitespace either side.
 */
import { ref, computed, onMounted, watch } from 'vue'
import api from '@/api/client.js'
import { useLeagueStore } from '@/stores/league.js'
import StandingsTable from '@/components/StandingsTable.vue'
import PlayoffPicture from '@/components/PlayoffPicture.vue'

const league = useLeagueStore()

const overview = ref(null)
const rosters = ref([])
const selectedWeek = ref(null)
const selectedTeamId = ref(null)
const loading = ref(true)
const rostersLoading = ref(false)
const error = ref(null)

const myTeamId = computed(() => league.myTeam?.id ?? null)
const playoffs = computed(() => overview.value?.playoffs ?? null)
const weeks = computed(() => overview.value?.weeks ?? [])

const activeWeek = computed(() => weeks.value.find((w) => w.week === selectedWeek.value) ?? null)

const spots = computed(() => playoffs.value?.spots ?? 0)

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api.leagueOverview()
    overview.value = data
    // Land on the week people care about: the one being played.
    selectedWeek.value = data.currentWeek
    if (!data.weeks.some((w) => w.week === data.currentWeek)) {
      selectedWeek.value = data.weeks[data.weeks.length - 1]?.week ?? 1
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

const selectedTeam = computed(
  () => rosters.value.find((t) => t.id === selectedTeamId.value) ?? null,
)

/** Set once the manager clicks, so we stop overriding their choice. */
const teamPicked = ref(false)

/**
 * Default the roster pane to the viewer's own team.
 *
 * The session store and this view load independently, so `myTeamId` may not be
 * resolved when the rosters arrive. Rather than guessing once, re-apply whenever
 * either side lands — and stop as soon as the manager picks a team themselves.
 */
function applyDefaultTeam() {
  if (teamPicked.value || rosters.value.length === 0) return
  const mine = rosters.value.find((t) => t.id === myTeamId.value)
  selectedTeamId.value = mine?.id ?? rosters.value[0]?.id ?? null
}

watch(myTeamId, applyDefaultTeam)

function pickTeam(teamId) {
  teamPicked.value = true
  selectedTeamId.value = teamId
}

async function loadRosters() {
  if (rosters.value.length || rostersLoading.value) return
  rostersLoading.value = true
  try {
    rosters.value = (await api.rosters(league.currentWeek)).teams
    applyDefaultTeam()
  } catch (err) {
    error.value = err.message
  } finally {
    rostersLoading.value = false
  }
}

const weekLabel = (week) => (playoffs.value && week.isPlayoff ? `${week.week}★` : String(week.week))

onMounted(async () => {
  await load()
  loadRosters()
})
</script>

<template>
  <div class="stack">
    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="loading" class="card"><div class="empty">Loading league…</div></div>

    <template v-if="overview">
      <!-- Only during the playoffs. The regular-season race said nothing the
           standings cutoff line doesn't already show, but the bracket itself
           (semifinals, final, scores) has no equivalent there. -->
      <PlayoffPicture v-if="playoffs?.bracket" :playoffs="playoffs" :my-team-id="myTeamId" />

      <!-- Standings + this week's games, side by side so neither is stranded. -->
      <div class="split">
        <div class="card">
          <div class="card-header">
            <h2>Standings</h2>
            <span v-if="spots" class="tiny faint">
              Top {{ spots }} make the playoffs<template v-if="playoffs && !playoffs.inPlayoffs">
                · {{ playoffs.weeksRemaining }} to play</template>
            </span>
          </div>
          <div class="card-body flush">
            <StandingsTable
              :standings="overview.standings"
              :highlight-team-id="myTeamId"
              :playoff-spots="spots"
              detailed
            />
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Schedule &amp; results</h2>
            <span class="tiny faint">
              <template v-if="activeWeek?.isPlayoff">Championship leg</template>
              <template v-else-if="activeWeek?.complete">Final</template>
              <template v-else>In progress</template>
            </span>
          </div>

          <div class="week-picker">
            <button
              v-for="week in weeks"
              :key="week.week"
              class="week-chip"
              :class="{
                active: week.week === selectedWeek,
                playoff: week.isPlayoff,
                current: week.week === overview.currentWeek,
              }"
              :title="week.isPlayoff ? 'Championship week' : `Week ${week.week}`"
              @click="selectedWeek = week.week"
            >
              {{ weekLabel(week) }}
            </button>
          </div>

          <div class="card-body flush">
            <div v-if="!activeWeek" class="empty">No games scheduled for that week.</div>
            <div
              v-for="(m, i) in activeWeek?.matchups || []"
              :key="i"
              class="game"
              :class="{ mine: m.home_id === myTeamId || m.away_id === myTeamId }"
            >
              <div class="side" :class="{ won: m.status === 'final' && m.away_score > m.home_score }">
                <span class="abbr mono">{{ m.away_abbr }}</span>
                <span class="team-name">{{ m.away_name }}</span>
                <span class="score mono">{{ m.status === 'final' ? m.away_score.toFixed(1) : '—' }}</span>
              </div>
              <div class="side" :class="{ won: m.status === 'final' && m.home_score > m.away_score }">
                <span class="abbr mono">{{ m.home_abbr }}</span>
                <span class="team-name">{{ m.home_name }}</span>
                <span class="score mono">{{ m.status === 'final' ? m.home_score.toFixed(1) : '—' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Rosters as master-detail. An expanding grid stretched whichever row
           held the open card, leaving gaps beside it; a fixed team list with one
           detail pane never does that. -->
      <div class="card">
        <div class="card-header">
          <h2>Rosters</h2>
          <a
            v-if="league.league?.draftUrl"
            :href="league.league.draftUrl"
            target="_blank"
            rel="noopener"
            class="tiny"
          >
            Draft board ↗
          </a>
        </div>

        <div v-if="rostersLoading && !rosters.length" class="empty">Loading rosters…</div>

        <div v-else class="roster-split">
          <div class="team-list">
            <button
              v-for="team in rosters"
              :key="team.id"
              class="team-item"
              :class="{ active: selectedTeamId === team.id, mine: team.id === myTeamId }"
              @click="pickTeam(team.id)"
            >
              <span class="small bold tname">{{ team.name }}</span>
              <span class="tiny faint">{{ team.manager || 'Unclaimed' }}</span>
            </button>
          </div>

          <div v-if="selectedTeam" class="roster-detail">
            <div class="detail-head">
              <div>
                <div class="bold">{{ selectedTeam.name }}</div>
                <div class="tiny faint">{{ selectedTeam.manager || 'Unclaimed' }}</div>
              </div>
              <div class="tiny faint">Week {{ overview.currentWeek }}</div>
            </div>

            <div v-for="slot in selectedTeam.starters" :key="slot.slot" class="lineup-row">
              <span class="slot-tag tiny">{{ slot.label }}</span>
              <template v-if="slot.player">
                <span class="pill pill-pos" :class="`pos-${slot.player.position}`">
                  {{ slot.player.position }}
                </span>
                <span class="small pname">{{ slot.player.name }}</span>
                <span class="tiny faint nfl">{{ slot.player.nflTeam }}</span>
                <span class="mono small">{{ slot.player.points.toFixed(1) }}</span>
              </template>
              <span v-else class="faint small pname">Empty</span>
            </div>

            <div class="bench-label tiny">Bench — scores 0</div>
            <div v-for="player in selectedTeam.bench" :key="player.id" class="lineup-row bench">
              <span class="slot-tag tiny">BN</span>
              <span class="pill pill-pos" :class="`pos-${player.position}`">{{ player.position }}</span>
              <span class="small pname">{{ player.name }}</span>
              <span class="tiny faint nfl">{{ player.nflTeam }}</span>
              <!-- What they scored, even though it counted for nothing. Leaving
                   it blank made it impossible to see the points someone left on
                   their bench, which is half the fun of reading a roster. -->
              <span class="mono small bench-pts">{{ (player.points ?? 0).toFixed(1) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@media (max-width: 980px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---- week picker ---- */

.week-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-inset);
}

.week-chip {
  min-width: 2rem;
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.week-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.week-chip.current {
  border-color: var(--border-strong);
  color: var(--text);
}

.week-chip.playoff {
  color: var(--warn);
}

.week-chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #06120c;
  font-weight: 700;
}

/* ---- games ---- */

.game {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}

.game:last-child {
  border-bottom: none;
}

.game.mine {
  box-shadow: inset 2px 0 0 var(--accent);
}

.side {
  display: grid;
  grid-template-columns: 2.6rem 1fr auto;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.1rem 0;
}

.abbr {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-faint);
}

.team-name {
  font-size: 0.85rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.score {
  font-size: 0.9rem;
  color: var(--text-muted);
}

.side.won .team-name,
.side.won .score {
  color: var(--text);
  font-weight: 600;
}

/* ---- rosters: master-detail ---- */

.roster-split {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  align-items: stretch;
}

.team-list {
  border-right: 1px solid var(--border);
  background: var(--bg-inset);
  display: flex;
  flex-direction: column;
}

.team-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.05rem;
  padding: 0.5rem 0.85rem;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  border-left: 2px solid transparent;
  color: inherit;
  text-align: left;
  width: 100%;
}

.team-item:last-child {
  border-bottom: none;
}

.team-item:hover {
  background: var(--surface);
}

.team-item.active {
  background: var(--bg-raised);
  border-left-color: var(--accent);
}

.team-item.mine .tname {
  color: var(--accent-hover);
}

.tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.roster-detail {
  min-width: 0;
}

.detail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
}

.lineup-row {
  display: grid;
  grid-template-columns: 2.4rem 2.8rem minmax(0, 1fr) 2.6rem 3rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.32rem 1rem;
  border-bottom: 1px solid var(--border);
}

.lineup-row:last-child {
  border-bottom: none;
}

/* Deliberately inherits the starter grid. The bench used to override this with
   one fewer column, from when it had no points cell — adding one pushed it into
   an implicit column that lined up with nothing. */
.lineup-row.bench {
  opacity: 0.75;
}

.pname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nfl {
  text-align: right;
}

.lineup-row .mono {
  text-align: right;
}

.slot-tag {
  font-weight: 700;
  color: var(--text-faint);
  text-transform: uppercase;
}

.bench-pts {
  color: var(--text-faint);
}

.bench-label {
  padding: 0.4rem 1rem 0.2rem;
  background: var(--bg-inset);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  font-weight: 700;
}

/* On a phone the sidebar becomes a horizontal strip of teams above the roster. */
@media (max-width: 760px) {
  .roster-split {
    grid-template-columns: minmax(0, 1fr);
  }

  .team-list {
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .team-item {
    border-bottom: none;
    border-left: none;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    width: auto;
    flex: 0 0 auto;
  }

  .team-item.active {
    border-bottom-color: var(--accent);
  }

  /* Reclaim the padding and the NFL-team column so long names still fit. */
  .lineup-row {
    grid-template-columns: 2.2rem 2.6rem minmax(0, 1fr) 2.2rem 2.8rem;
    padding-left: 0.6rem;
    padding-right: 0.6rem;
    gap: 0.35rem;
  }

  .detail-head,
  .bench-label {
    padding-left: 0.6rem;
    padding-right: 0.6rem;
  }
}
</style>
