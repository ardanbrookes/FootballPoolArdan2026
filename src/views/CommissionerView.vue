<script setup>
/**
 * Commissioner console.
 *
 * Every action here bypasses the lock phases and roster limits on purpose —
 * you're only on this page because the normal path refused something. Two
 * things follow from that, and both are reflected in the UI: destructive moves
 * confirm first, and every one of them announces itself in the league feed, so
 * nobody discovers a change by noticing their roster looks different.
 */

import { ref, computed, onMounted } from 'vue'
import api from '@/api/client.js'
import { useLeagueStore, useSessionStore } from '@/stores/league.js'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const league = useLeagueStore()
const session = useSessionStore()

const TABS = [
  { id: 'rosters', label: 'Rosters' },
  { id: 'undo', label: 'Undo' },
  { id: 'scores', label: 'Scores' },
  { id: 'league', label: 'League' },
]
const tab = ref('rosters')

const data = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref(null)
const notice = ref(null)
const week = ref(null)

const confirm = ref(null)

const teams = computed(() => data.value?.rosters ?? [])
const currentWeek = computed(() => data.value?.league?.currentWeek ?? 1)

function flash(message) {
  notice.value = message
  setTimeout(() => (notice.value = null), 6000)
}

async function load(forWeek) {
  loading.value = true
  error.value = null
  try {
    data.value = await api.commish.overview(forWeek ?? week.value ?? undefined)
    week.value = data.value.week
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

/**
 * Every mutation funnels through here so a failure can never leave the console
 * showing stale rosters next to a success message.
 */
async function act(fn, successMessage) {
  busy.value = true
  error.value = null
  try {
    const result = await fn()
    await load()
    await league.load()
    const warnings = result?.warnings?.length ? ` ${result.warnings.join(' ')}` : ''
    const summary = result?.summary?.length ? ` ${result.summary.join('; ')}.` : ''
    flash(`${successMessage}${summary}${warnings}`)
    return result
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
    confirm.value = null
  }
}

onMounted(load)

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------

const selected = ref(null)
const moveTarget = ref('')
const moveNote = ref('')

function pick(player, teamId, teamName) {
  selected.value = selected.value?.id === player.id ? null : { ...player, teamId, teamName }
  moveTarget.value = ''
  moveNote.value = ''
}

const moveDestinations = computed(() =>
  teams.value.filter((t) => t.id !== selected.value?.teamId),
)

function doMove() {
  const player = selected.value
  const toTeamId = moveTarget.value ? Number(moveTarget.value) : null
  const destination = toTeamId ? teams.value.find((t) => t.id === toTeamId)?.name : 'free agency'

  confirm.value = {
    title: 'Move this player?',
    message: `${player.full_name} goes from ${player.teamName} to ${destination}.`,
    detail: toTeamId
      ? 'They are removed from their current lineup for this week. The move is announced in the league feed.'
      : 'They become a free agent immediately — not a waiver claim — so anyone can sign them right away.',
    confirmLabel: 'Move player',
    destructive: !toTeamId,
    run: () =>
      act(
        () => api.commish.movePlayer(player.id, toTeamId, { note: moveNote.value || undefined }),
        `${player.full_name} moved.`,
      ).then(() => (selected.value = null)),
  }
}

function toggleIr(player) {
  act(() => api.commish.setIr(player.id, !player.on_ir), `${player.full_name} IR status updated.`)
}

// Adding an unrostered player straight onto a team.
const search = ref('')
const results = ref([])
const searching = ref(false)
const addTo = ref('')

async function runSearch() {
  if (search.value.trim().length < 2) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const payload = await api.searchPlayers({ search: search.value.trim(), limit: 15 })
    results.value = payload.players
  } catch (err) {
    error.value = err.message
  } finally {
    searching.value = false
  }
}

function addPlayer(player) {
  const teamId = Number(addTo.value)
  const team = teams.value.find((t) => t.id === teamId)
  if (!team) {
    error.value = 'Choose which team gets this player first.'
    return
  }

  confirm.value = {
    title: 'Add to roster?',
    message: `${player.full_name} joins ${team.name}.`,
    detail:
      'Roster limits are not enforced here — if this puts the team over the cap you will get a warning, not a refusal.',
    confirmLabel: 'Add player',
    run: () =>
      act(() => api.commish.movePlayer(player.id, teamId), `${player.full_name} added to ${team.name}.`).then(
        () => {
          search.value = ''
          results.value = []
        },
      ),
  }
}

function setAvailability(player, status) {
  act(
    () => api.commish.setPoolStatus(player.id, status),
    `${player.full_name} is now ${status === 'waivers' ? 'on waivers' : 'a free agent'}.`,
  )
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function undoTransaction(tx) {
  confirm.value = {
    title: 'Reverse this move?',
    message:
      tx.type === 'drop'
        ? `${tx.player_name} goes back onto ${tx.team_name}.`
        : tx.related_team_name
          ? `${tx.player_name} returns to ${tx.related_team_name}.`
          : `${tx.player_name} comes off ${tx.team_name}${tx.related_player_name ? `, and ${tx.related_player_name} goes back on` : ' and becomes a free agent'}.`,
    detail:
      'The original transaction stays in the history — a reversal is recorded alongside it rather than erasing it.',
    confirmLabel: 'Reverse',
    run: () => act(() => api.commish.undoTransaction(tx.id), 'Move reversed.'),
  }
}

function undoTrade(trade) {
  confirm.value = {
    title: 'Reverse this trade?',
    message: `Everyone goes back to the team they started on — ${trade.players.map((p) => p.name).join(', ')}.`,
    detail: `${trade.proposer_name} and ${trade.receiver_name} are both notified in the league feed.`,
    confirmLabel: 'Reverse trade',
    destructive: true,
    run: () => act(() => api.commish.undoTrade(trade.id), 'Trade reversed.'),
  }
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

const scoreDraft = ref({})

function startEdit(matchup) {
  scoreDraft.value = {
    ...scoreDraft.value,
    [matchup.id]: { home: matchup.home_score, away: matchup.away_score, status: matchup.status },
  }
}

function saveScore(matchup) {
  const draft = scoreDraft.value[matchup.id]
  act(
    () => api.commish.setScore(matchup.id, Number(draft.home), Number(draft.away), draft.status),
    'Score saved and pinned.',
  ).then(() => {
    const next = { ...scoreDraft.value }
    delete next[matchup.id]
    scoreDraft.value = next
  })
}

function clearOverride(matchup) {
  act(() => api.commish.clearScore(matchup.id), 'Score handed back to automatic scoring.')
}

function recalculate() {
  act(() => api.commish.recalculate(week.value, false), `Week ${week.value} rescored.`)
}

// ---------------------------------------------------------------------------
// League
// ---------------------------------------------------------------------------

const weekDraft = ref(null)

function applyWeek() {
  const target = Number(weekDraft.value)
  confirm.value = {
    title: 'Change the league week?',
    message: `The league moves from week ${currentWeek.value} to week ${target}.`,
    detail:
      'This does not re-score anything or undo a week reset — it only changes which week the app treats as current.',
    confirmLabel: 'Set week',
    destructive: true,
    run: () => act(() => api.commish.setWeek(target), `League set to week ${target}.`),
  }
}

const notCommissioner = computed(() => session.ready && !session.user?.isCommissioner)
</script>

<template>
  <div class="stack">
    <div v-if="notCommissioner" class="alert alert-error">
      Commissioner tools are only available to the league commissioner.
    </div>

    <template v-else>
      <div v-if="notice" class="alert alert-success">{{ notice }}</div>
      <div v-if="error" class="alert alert-error">{{ error }}</div>

      <div class="card">
        <div class="card-header">
          <h2>Commissioner tools</h2>
          <span class="tiny faint">Week {{ currentWeek }}</span>
        </div>
        <div class="card-body">
          <p class="small muted intro">
            Everything here ignores the lock phases and roster limits, and every action is posted to the
            league feed. Undo never deletes history — it records a reversal next to the original.
          </p>
          <div class="tabs">
            <button
              v-for="t in TABS"
              :key="t.id"
              class="tab"
              :class="{ active: tab === t.id }"
              @click="tab = t.id"
            >
              {{ t.label }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="loading && !data" class="empty">Loading…</div>

      <!-- Rosters ------------------------------------------------------- -->
      <template v-else-if="tab === 'rosters'">
        <div class="card">
          <div class="card-header"><h2>Add a player to a team</h2></div>
          <div class="card-body">
            <div class="row add-row">
              <select v-model="addTo">
                <option value="">Choose a team…</option>
                <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <input
                v-model="search"
                placeholder="Search any player…"
                @input="runSearch"
              />
            </div>
            <p v-if="searching" class="tiny faint">Searching…</p>
            <div v-if="results.length" class="results">
              <button
                v-for="player in results"
                :key="player.id"
                class="result"
                :disabled="busy || !addTo"
                @click="addPlayer(player)"
              >
                <span>
                  <strong>{{ player.full_name }}</strong>
                  <span class="tiny faint"> {{ player.position }} · {{ player.nfl_team || 'FA' }}</span>
                </span>
                <span class="tiny" :class="player.availability === 'rostered' ? 'warn-text' : 'faint'">
                  {{ player.availability === 'rostered' ? `on ${player.owner_team_name}` : player.availability }}
                </span>
              </button>
            </div>
            <p v-if="results.length" class="tiny faint hint">
              A rostered player can be picked too — they move straight from their current team.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Rosters</h2>
            <span class="tiny faint">Click a player to move or release them</span>
          </div>
          <div class="card-body">
            <div class="roster-grid">
              <div v-for="team in teams" :key="team.id" class="team-col">
                <h3 class="small bold">{{ team.name }}</h3>
                <button
                  v-for="player in team.players"
                  :key="player.id"
                  class="player-row"
                  :class="{ selected: selected?.id === player.id, ir: player.on_ir }"
                  @click="pick(player, team.id, team.name)"
                >
                  <span class="pos">{{ player.position }}</span>
                  <span class="name">{{ player.full_name }}</span>
                  <span v-if="player.on_ir" class="tiny pill-ir">IR</span>
                </button>
                <p v-if="!team.players.length" class="tiny faint">Empty roster.</p>
              </div>
            </div>
          </div>
        </div>

        <div v-if="selected" class="card">
          <div class="card-header">
            <h2>{{ selected.full_name }}</h2>
            <span class="tiny faint">{{ selected.position }} · {{ selected.teamName }}</span>
          </div>
          <div class="card-body stack-sm">
            <div class="row add-row">
              <select v-model="moveTarget">
                <option value="">Release to free agency</option>
                <option v-for="t in moveDestinations" :key="t.id" :value="t.id">Move to {{ t.name }}</option>
              </select>
              <input v-model="moveNote" placeholder="Reason (optional, shown in chat)" />
              <button class="btn btn-primary btn-sm" :disabled="busy" @click="doMove">Apply</button>
            </div>
            <div class="row">
              <button class="btn btn-ghost btn-sm" :disabled="busy" @click="toggleIr(selected)">
                {{ selected.on_ir ? 'Activate from IR' : 'Place on IR' }}
              </button>
              <button class="btn btn-ghost btn-sm" @click="selected = null">Close</button>
            </div>
          </div>
        </div>
      </template>

      <!-- Undo ---------------------------------------------------------- -->
      <template v-else-if="tab === 'undo'">
        <div class="card">
          <div class="card-header">
            <h2>Recent moves</h2>
            <span class="tiny faint">{{ data?.transactions?.length ?? 0 }}</span>
          </div>
          <div class="card-body flush">
            <div v-for="tx in data?.transactions ?? []" :key="tx.id" class="tx-row">
              <div class="tx-main">
                <span class="pill" :class="`pill-${tx.type}`">{{ tx.type }}</span>
                <span class="small">
                  <strong>{{ tx.team_name }}</strong>
                  {{ tx.type === 'add' ? 'signed' : tx.type === 'drop' ? 'dropped' : 'traded' }}
                  {{ tx.player_name }}
                  <span v-if="tx.related_player_name" class="faint">
                    (dropping {{ tx.related_player_name }})
                  </span>
                </span>
                <span class="tiny faint">wk {{ tx.week }} · {{ tx.source }}</span>
              </div>
              <button
                v-if="tx.undoable"
                class="btn btn-sm btn-ghost"
                :disabled="busy"
                @click="undoTransaction(tx)"
              >
                Undo
              </button>
              <span v-else class="tiny faint blocked">{{ tx.blockedReason }}</span>
            </div>
            <div v-if="!data?.transactions?.length" class="empty">No transactions yet.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>Completed trades</h2></div>
          <div class="card-body flush">
            <div v-for="trade in data?.trades ?? []" :key="trade.id" class="tx-row">
              <div class="tx-main">
                <span class="pill" :class="trade.status === 'reversed' ? 'pill-danger' : 'pill-accent'">
                  {{ trade.status }}
                </span>
                <span class="small">
                  <strong>{{ trade.proposer_name }}</strong> ↔ <strong>{{ trade.receiver_name }}</strong>
                  <span class="faint"> — {{ trade.players.map((p) => p.name).join(', ') }}</span>
                </span>
                <span class="tiny faint">wk {{ trade.week }}</span>
              </div>
              <button
                v-if="trade.reversible"
                class="btn btn-sm btn-ghost"
                :disabled="busy"
                @click="undoTrade(trade)"
              >
                Reverse
              </button>
              <span v-else class="tiny faint blocked">{{ trade.blockedReason }}</span>
            </div>
            <div v-if="!data?.trades?.length" class="empty">No completed trades.</div>
          </div>
        </div>
      </template>

      <!-- Scores -------------------------------------------------------- -->
      <template v-else-if="tab === 'scores'">
        <div class="card">
          <div class="card-header">
            <h2>Week {{ week }} scores</h2>
            <div class="row">
              <select :value="week" @change="load(Number($event.target.value))">
                <option v-for="n in 18" :key="n" :value="n">Week {{ n }}</option>
              </select>
              <button class="btn btn-ghost btn-sm" :disabled="busy" @click="recalculate">
                Rescore from stats
              </button>
            </div>
          </div>
          <div class="card-body flush">
            <div v-for="m in data?.matchups ?? []" :key="m.id" class="matchup-row">
              <div class="matchup-teams small">
                <span>{{ m.home_name }}</span>
                <span class="faint">vs</span>
                <span>{{ m.away_name }}</span>
                <span v-if="m.manual_override" class="pill pill-warn tiny">pinned</span>
              </div>

              <div v-if="scoreDraft[m.id]" class="row score-edit">
                <input v-model="scoreDraft[m.id].home" type="number" step="0.01" class="score-input" />
                <input v-model="scoreDraft[m.id].away" type="number" step="0.01" class="score-input" />
                <select v-model="scoreDraft[m.id].status">
                  <option value="scheduled">scheduled</option>
                  <option value="in_progress">in progress</option>
                  <option value="final">final</option>
                </select>
                <button class="btn btn-primary btn-sm" :disabled="busy" @click="saveScore(m)">Save</button>
              </div>

              <div v-else class="row score-view">
                <span class="mono">{{ m.home_score }} — {{ m.away_score }}</span>
                <span class="tiny faint">{{ m.status }}</span>
                <button class="btn btn-ghost btn-sm" @click="startEdit(m)">Edit</button>
                <button
                  v-if="m.manual_override"
                  class="btn btn-ghost btn-sm"
                  :disabled="busy"
                  @click="clearOverride(m)"
                >
                  Unpin
                </button>
              </div>
            </div>
            <div v-if="!data?.matchups?.length" class="empty">No matchups scheduled for this week.</div>
          </div>
        </div>

        <p class="small muted note">
          A saved score is <strong>pinned</strong>: the automatic stats refresh skips it from then on, so your
          correction survives. Unpin to hand that matchup back to normal scoring. Standings recompute from
          final matchups after every change.
        </p>
      </template>

      <!-- League -------------------------------------------------------- -->
      <template v-else>
        <div class="card">
          <div class="card-header"><h2>Current week</h2></div>
          <div class="card-body">
            <p class="small muted">
              The league is on <strong>week {{ currentWeek }}</strong>. Change this only to correct a week that
              advanced at the wrong time — it does not re-score or undo anything, it just changes which week
              the app treats as live.
            </p>
            <div class="row add-row">
              <select v-model="weekDraft">
                <option :value="null">Choose a week…</option>
                <option v-for="n in 18" :key="n" :value="n">Week {{ n }}</option>
              </select>
              <button class="btn btn-primary btn-sm" :disabled="busy || !weekDraft" @click="applyWeek">
                Set week
              </button>
            </div>
          </div>
        </div>
      </template>
    </template>

    <ConfirmDialog
      :open="Boolean(confirm)"
      :title="confirm?.title"
      :message="confirm?.message"
      :detail="confirm?.detail"
      :confirm-label="confirm?.confirmLabel"
      :destructive="confirm?.destructive"
      :busy="busy"
      @confirm="confirm?.run()"
      @cancel="confirm = null"
    />
  </div>
</template>

<style scoped>
.intro {
  margin: 0 0 0.75rem;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.tab {
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.3rem 0.85rem;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.85rem;
}

.tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.add-row {
  gap: 0.5rem;
  flex-wrap: wrap;
}

.add-row input {
  flex: 1;
  min-width: 12rem;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.75rem;
}

.result {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.result:hover:not(:disabled) {
  border-color: var(--accent);
}

.result:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hint {
  margin: 0.5rem 0 0;
}

.warn-text {
  color: var(--warn);
}

.roster-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: 1rem;
}

.team-col h3 {
  margin-bottom: 0.4rem;
}

.player-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 0.25rem 0.4rem;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-size: 0.85rem;
}

.player-row:hover {
  background: var(--bg-raised);
}

.player-row.selected {
  border-color: var(--accent);
  background: var(--bg-raised);
}

.player-row.ir {
  opacity: 0.65;
}

.player-row .pos {
  width: 2.1rem;
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 0.7rem;
  text-transform: uppercase;
}

.player-row .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-ir {
  background: var(--warn);
  color: var(--bg);
  border-radius: 3px;
  padding: 0 0.25rem;
}

.tx-row,
.matchup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.tx-row:last-child,
.matchup-row:last-child {
  border-bottom: none;
}

.tx-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  min-width: 0;
}

.blocked {
  max-width: 18rem;
  text-align: right;
}

.pill-add {
  background: var(--accent);
  color: var(--bg);
}

.pill-drop {
  background: var(--danger);
  color: var(--bg);
}

.pill-trade {
  background: var(--accent-hover);
  color: var(--bg);
}

.pill-warn {
  background: var(--warn);
  color: var(--bg);
}

.matchup-teams {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.score-input {
  width: 5.5rem;
}

.score-edit,
.score-view {
  gap: 0.5rem;
  align-items: center;
}

.note {
  margin: 0;
}
</style>
