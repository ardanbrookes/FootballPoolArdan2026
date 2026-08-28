<script setup>
/**
 * Rules, generated from the live config rather than written out by hand — so
 * the page can never drift from what the server actually enforces.
 */
import { computed } from 'vue'
import { useLeagueStore } from '@/stores/league.js'

const league = useLeagueStore()

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const timing = computed(() => league.config?.timing)

const fmt = (spec) => {
  if (!spec) return '—'
  const hour12 = spec.hour % 12 === 0 ? 12 : spec.hour % 12
  const suffix = spec.hour < 12 ? 'AM' : 'PM'
  return `${DAYS[spec.weekday]} ${hour12}:${String(spec.minute).padStart(2, '0')} ${suffix}`
}

const slots = computed(() => league.config?.rosterSlots ?? [])
const playoffs = computed(() => league.config?.playoffs ?? null)

/**
 * Scoring table, grouped and labelled from the live config — so the rules page
 * can never claim a value the scoring engine isn't actually using.
 */
const SCORING_LABELS = {
  pass_yd: ['Passing', 'Passing yards', (v) => `1 per ${Math.round(1 / v)} yds`],
  pass_td: ['Passing', 'Passing TD'],
  pass_int: ['Passing', 'Interception thrown'],
  pass_2pt: ['Passing', '2-point conversion'],
  rush_yd: ['Rushing', 'Rushing yards', (v) => `1 per ${Math.round(1 / v)} yds`],
  rush_td: ['Rushing', 'Rushing TD'],
  rush_2pt: ['Rushing', '2-point conversion'],
  rec: ['Receiving', 'Per reception'],
  rec_yd: ['Receiving', 'Receiving yards', (v) => `1 per ${Math.round(1 / v)} yds`],
  rec_td: ['Receiving', 'Receiving TD'],
  rec_2pt: ['Receiving', '2-point conversion'],
  fum_lost: ['Receiving', 'Fumble lost'],
  fgm_0_19: ['Kicking', 'FG under 20'],
  fgm_20_29: ['Kicking', 'FG 20–29'],
  fgm_30_39: ['Kicking', 'FG 30–39'],
  fgm_40_49: ['Kicking', 'FG 40–49'],
  fgm_50p: ['Kicking', 'FG 50+'],
  fgmiss: ['Kicking', 'Missed FG'],
  xpm: ['Kicking', 'Extra point'],
  xpmiss: ['Kicking', 'Missed XP'],
  sack: ['Defence', 'Sack'],
  int: ['Defence', 'Interception'],
  fum_rec: ['Defence', 'Fumble recovery'],
  def_td: ['Defence', 'Defensive TD'],
  safe: ['Defence', 'Safety'],
  blk_kick: ['Defence', 'Blocked kick'],
  pts_allow_0: ['Points allowed', 'Shutout'],
  pts_allow_1_6: ['Points allowed', '1–6'],
  pts_allow_7_13: ['Points allowed', '7–13'],
  pts_allow_14_20: ['Points allowed', '14–20'],
  pts_allow_21_27: ['Points allowed', '21–27'],
  pts_allow_28_34: ['Points allowed', '28–34'],
  pts_allow_35p: ['Points allowed', '35+'],
}

const GROUP_ORDER = ['Passing', 'Rushing', 'Receiving', 'Kicking', 'Defence', 'Points allowed']

const scoringGroups = computed(() => {
  const scoring = league.config?.scoring
  if (!scoring) return []

  const grouped = new Map()
  for (const [key, value] of Object.entries(scoring)) {
    const entry = SCORING_LABELS[key]
    if (!entry) continue
    const [group, label, format] = entry
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group).push({ key, label: format ? `${label} (${format(value)})` : label, value })
  }

  return GROUP_ORDER.filter((name) => grouped.has(name)).map((name) => ({
    name,
    rows: grouped.get(name),
  }))
})
</script>

<template>
  <div class="stack">
    <div class="card">
      <div class="card-header"><h2>Roster</h2></div>
      <div class="card-body">
        <p class="small muted" style="margin-top: 0">
          {{ slots.length }} starters plus {{ league.config?.benchSize }} bench spots
          ({{ league.config?.maxPlayers }} players total). Bench players score nothing — only the starting
          lineup counts toward your weekly total.
        </p>
        <div class="slot-grid">
          <div v-for="slot in slots" :key="slot.slot" class="slot-box">
            <div class="bold small">{{ slot.label }}</div>
            <div class="tiny faint">{{ slot.eligible.join(' / ') }}</div>
          </div>
          <div class="slot-box bench">
            <div class="bold small">BN ×{{ league.config?.benchSize }}</div>
            <div class="tiny faint">any position</div>
          </div>
          <div v-if="league.config?.irSlots" class="slot-box ir">
            <div class="bold small">IR ×{{ league.config.irSlots }}</div>
            <div class="tiny faint">injured only</div>
          </div>
        </div>

        <div v-if="league.config?.irSlots" style="margin-top: 1rem">
          <h3 class="small bold">Injured reserve</h3>
          <p class="small muted" style="margin: 0.25rem 0 0">
            {{ league.config.irSlots }} IR
            {{ league.config.irSlots === 1 ? 'slot lets you store one injured player' : 'slots let you store injured players' }}
            without using a bench spot — they don't count toward the
            {{ league.config?.maxPlayers }}-player limit, can't be started, and score nothing. Only players
            listed as
            <span class="mono tiny">{{ (league.config.irEligibleStatuses || []).join(', ') }}</span>
            qualify; Questionable isn't enough, or IR would just be a free extra bench spot. Activating
            someone needs an open roster spot, so you may have to drop a player first.
          </p>
          <p class="small muted" style="margin: 0.5rem 0 0">
            You can also sign or claim an injured free agent
            <strong>straight onto IR</strong>, even with a full roster — they never occupy an active
            spot, so nobody has to be dropped. If a waiver claim was made this way and the player is
            activated before waivers run, the claim fails rather than quietly taking a roster spot.
          </p>
        </div>
      </div>
    </div>

    <div v-if="playoffs" class="card">
      <div class="card-header"><h2>Season &amp; playoffs</h2></div>
      <div class="card-body">
        <p class="small muted" style="margin-top: 0">
          {{ playoffs.regularSeasonWeeks }} regular-season weeks, then a
          {{ playoffs.teams }}-team bracket. Seeding is by win percentage, with total points scored as
          the tiebreaker.
        </p>
        <ol class="cycle">
          <li v-for="round in playoffs.rounds" :key="round.week">
            <div class="bold small">Week {{ round.week }} — {{ round.name }}</div>
            <p class="small muted">
              <template v-if="round.pairings">
                {{ round.pairings.map((p) => `#${p[0]} v #${p[1]}`).join(' and ') }}. Higher seed hosts.
              </template>
              <template v-else> The two semifinal winners meet; the better seed hosts. </template>
            </p>
          </li>
        </ol>
        <p class="small muted" style="margin-bottom: 0">
          Single elimination. A tied game advances the higher seed, so the regular season always breaks
          a deadlock. Playoff results don't count toward regular-season records.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>The weekly cycle</h2></div>
      <div class="card-body">
        <ol class="cycle">
          <li>
            <div class="bold small">{{ fmt(timing?.blanketLock) }} — everything locks</div>
            <p class="small muted">
              All rosters freeze and trades close. Every remaining free agent moves to waivers, so from here
              nobody can be picked up instantly — they can only be claimed, and claims don't resolve until
              Tuesday.
            </p>
          </li>
          <li>
            <div class="bold small">Monday night, after the last game — rosters unlock</div>
            <p class="small muted">
              Scores go final, standings update, and trades reopen. This isn't a clock time: it's tied to the
              actual final whistle{{ timing?.weekReset?.bufferMinutes ? ` plus ${timing.weekReset.bufferMinutes} minutes` : '' }},
              so a late kickoff or a game running long moves it too. Waiver claims can be queued from now.
            </p>
          </li>
          <li>
            <div class="bold small">{{ fmt(timing?.waiverProcess) }} — waivers process</div>
            <p class="small muted">
              Claims resolve in Time-Since-Last-Claim order. Anyone left unclaimed becomes a free agent, and
              the open window begins — adds and drops are first come, first served.
            </p>
          </li>
          <li>
            <div class="bold small">Thursday kickoff — partial lock</div>
            <p class="small muted">
              When Thursday Night Football starts, <strong>only the two teams in that game</strong> lock.
              Every other player stays available for adds, drops and lineup changes right through the
              weekend. Any other pre-Sunday game (a Black Friday or late-season Saturday fixture) locks its
              two teams the same way.
            </p>
          </li>
        </ol>
        <p class="small muted" style="margin: 0.75rem 0 0">
          Above all of that: a player whose game is currently being played is always locked, whatever the
          phase says.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Waivers &amp; free agency</h2></div>
      <div class="card-body stack">
        <div>
          <h3 class="small bold">Priority: Time Since Last Claim</h3>
          <p class="small muted" style="margin: 0.25rem 0 0">
            The team that has gone longest without winning a claim picks first; a team that has never won one
            goes to the very front. Ties break toward the worse record, then fewer points scored. Winning a
            claim resets your clock and drops you to the back, so everyone gets a turn before anyone gets
            seconds.
          </p>
        </div>
        <div>
          <h3 class="small bold">Submitting claims</h3>
          <p class="small muted" style="margin: 0.25rem 0 0">
            Queue up to {{ league.config?.waivers?.maxClaimsPerTeam }} claims and rank them yourself. Each one
            can name a drop candidate, which is required once your roster is full. Claims that fail — because
            a higher-priority team got there first, or your drop candidate is gone — are reported with a
            reason.
          </p>
        </div>
        <div>
          <h3 class="small bold">Free agency</h3>
          <p class="small muted" style="margin: 0.25rem 0 0">
            Once waivers clear, unclaimed players are first come, first served for the rest of the week.
            Dropped players go back on waivers rather than straight to free agency.
          </p>
        </div>
      </div>
    </div>

    <div v-if="scoringGroups.length" class="card">
      <div class="card-header">
        <h2>Scoring</h2>
        <span class="tiny faint">Half PPR</span>
      </div>
      <div class="card-body">
        <p class="small muted" style="margin-top: 0">
          Half PPR: {{ league.config?.scoring?.rec }} points per reception. Everything else is standard —
          1 point per 25 passing yards, 1 per 10 rushing or receiving yards, 6 for a touchdown.
        </p>
        <div class="scoring-grid">
          <div v-for="group in scoringGroups" :key="group.name" class="scoring-group">
            <div class="tiny faint bold group-head">{{ group.name }}</div>
            <div v-for="row in group.rows" :key="row.key" class="scoring-row">
              <span class="small">{{ row.label }}</span>
              <span class="mono small" :class="row.value < 0 ? 'neg' : ''">
                {{ row.value > 0 ? '+' : '' }}{{ row.value }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Timezone</h2></div>
      <div class="card-body">
        <p class="small muted" style="margin: 0">
          All deadlines are in <strong>{{ timing?.timezone }}</strong> and adjust automatically for daylight
          saving. The commissioner can change any of these times without a redeploy.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.slot-box {
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}

.slot-box.bench {
  border-style: dashed;
}

.slot-box.ir {
  border-style: dashed;
  border-color: rgba(224, 82, 82, 0.4);
}

.scoring-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: 0.75rem 1.25rem;
  margin-top: 0.75rem;
}

.scoring-group {
  min-width: 0;
}

.group-head {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.25rem;
}

.scoring-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.12rem 0;
}

.scoring-row .neg {
  color: var(--danger);
}

.cycle {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.cycle p {
  margin: 0.2rem 0 0;
}
</style>
