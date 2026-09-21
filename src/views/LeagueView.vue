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
import MatchupScoreboard from '@/components/MatchupScoreboard.vue'

const league = useLeagueStore()

const overview = ref(null)
const rosters = ref([])
const selectedWeek = ref(null)
const selectedTeamId = ref(null)
const loading = ref(true)
const rostersLoading = ref(false)
// The server decides which week the rosters show — the one just played, until
// the next week kicks off — so the label follows its answer rather than ours.
const rostersWeek = ref(null)
const error = ref(null)

const myTeamId = computed(() => league.myTeam?.id ?? null)
const playoffs = computed(() => overview.value?.playoffs ?? null)
const weeks = computed(() => overview.value?.weeks ?? [])

const activeWeek = computed(() => weeks.value.find((w) => w.week === selectedWeek.value) ?? null)

const spots = computed(() => playoffs.value?.spots ?? 0)

const weekMatchups = computed(() => activeWeek.value?.matchups ?? [])

/**
 * Any game in the league, in the same scoreboard the home page uses.
 *
 * Tracked by a team rather than a matchup id: that is what the endpoint
 * takes, and it survives the week changing underneath — switching weeks
 * keeps you on a real game rather than an id belonging to another week.
 */
const viewerTeamId = ref(null)
const viewerDetail = ref(null)
const viewerLoading = ref(false)
/** Set once the manager picks a game, so we stop defaulting back to theirs. */
const matchupPicked = ref(false)

const viewerHeading = computed(() =>
  selectedWeek.value ? 'Week ' + selectedWeek.value + ' matchup' : 'Matchup',
)

const viewerEmpty = computed(() =>
  viewerLoading.value ? 'Loading matchup…' : 'No matchup to show.',
)

async function loadViewer() {
  const games = weekMatchups.value
  if (!games.length || !selectedWeek.value) {
    viewerDetail.value = null
    return
  }

  // Default to the viewer's own game, and fall back to it whenever the
  // current pick isn't in this week.
  const inWeek = games.some(
    (m) => m.home_id === viewerTeamId.value || m.away_id === viewerTeamId.value,
  )
  if (!inWeek || !matchupPicked.value) {
    const mine = games.find((m) => m.home_id === myTeamId.value || m.away_id === myTeamId.value)
    viewerTeamId.value = (mine ?? games[0]).home_id
  }

  viewerLoading.value = true
  try {
    const data = await api.matchupDetail(selectedWeek.value, viewerTeamId.value)
    viewerDetail.value = data.matchup
  } catch (err) {
    error.value = err.message
  } finally {
    viewerLoading.value = false
  }
}

function pickMatchup(teamId) {
  matchupPicked.value = true
  viewerTeamId.value = teamId
  loadViewer()
}

// The week picker drives this, and it needs the viewer's own team before it
// can choose a sensible default.
watch([selectedWeek, myTeamId], loadViewer)

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

/** Rosters and points for one week. No argument means whichever week the server picks. */
async function loadRosters(week = null) {
  if (rostersLoading.value) return
  rostersLoading.value = true
  try {
    const data = await api.rosters(week ?? undefined)
    rosters.value = data.teams
    rostersWeek.value = data.week
    applyDefaultTeam()
  } catch (err) {
    error.value = err.message
  } finally {
    rostersLoading.value = false
  }
}

function pickRosterWeek(week) {
  if (week === rostersWeek.value) return
  rostersWeek.value = week
  loadRosters(week)
}

/** A chip only says '3', so the hover text carries what that means. */
const weekTitle = (week) => (week.isPlayoff ? 'Championship week' : 'Week ' + week.week)

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

      <!-- Any game in the league, in the scoreboard the home page uses. It
           follows the week picker above. -->
      <div v-if="weekMatchups.length" class="stack">
        <div class="viewer-picker">
          <span class="tiny faint pick-label">Viewing</span>
          <button
            v-for="m in weekMatchups"
            :key="m.home_id"
            class="week-chip game-chip"
            :class="{
              active: viewerTeamId === m.home_id || viewerTeamId === m.away_id,
              mine: m.home_id === myTeamId || m.away_id === myTeamId,
            }"
            @click="pickMatchup(m.home_id)"
          >
            {{ m.away_abbr }} @ {{ m.home_abbr }}
          </button>
        </div>

        <MatchupScoreboard
          v-if="viewerDetail"
          :matchup="viewerDetail"
          :my-team-id="myTeamId"
          :heading="viewerHeading"
        />
        <div v-else class="card"><div class="empty">{{ viewerEmpty }}</div></div>
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

        <div class="week-picker">
          <button
            v-for="w in weeks"
            :key="w.week"
            class="week-chip"
            :class="{ active: w.week === rostersWeek, playoff: w.isPlayoff }"
            :title="weekTitle(w)"
            @click="pickRosterWeek(w.week)"
          >
            {{ weekLabel(w) }}
          </button>
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
              <div class="team-total">
                <div class="mono bold total-num">{{ (selectedTeam.total ?? 0).toFixed(1) }}</div>
                <div class="tiny faint">Week {{ rostersWeek ?? overview.currentWeek }} total</div>
              </div>
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

            <!-- IR scores nothing either, but who a team has parked there is
                 part of reading their roster. -->
            <template v-if="selectedTeam.ir?.length">
              <div class="bench-label tiny">Injured reserve — scores 0</div>
              <div v-for="player in selectedTeam.ir" :key="player.id" class="lineup-row bench">
                <span class="slot-tag tiny">IR</span>
                <span class="pill pill-pos" :class="`pos-${player.position}`">{{ player.position }}</span>
                <span class="small pname">
                  {{ player.name }}
                  <span v-if="!player.irEligible" class="pill pill-warn tiny">not eligible</span>
                </span>
                <span class="tiny faint nfl">{{ player.nflTeam }}</span>
                <span class="mono small bench-pts">{{ (player.points ?? 0).toFixed(1) }}</span>
              </div>
            </template>
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

.viewer-picker {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.pick-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: 0.2rem;
}

.game-chip {
  font-family: var(--mono);
}

.game-chip.mine {
  border-color: var(--border-strong);
  color: var(--accent-hover);
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

.team-total {
  text-align: right;
  flex-shrink: 0;
}

.total-num {
  font-size: 1.25rem;
  line-height: 1.1;
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
