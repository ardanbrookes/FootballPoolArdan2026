<script setup>
/**
 * News: a scrollable NFL feed that can be narrowed to the people you actually
 * care about.
 *
 * The four scopes all resolve server-side to "articles tagged with this set of
 * players", so the filter chips and the player search are the same mechanism
 * wearing different hats.
 */
import { ref, computed, watch, onUnmounted } from 'vue'
import { useLive, agoLabel } from '@/composables/useLive.js'
import api from '@/api/client.js'

const SCOPES = [
  { key: 'league', label: 'League', hint: 'Everything around the NFL' },
  { key: 'team', label: 'My team', hint: 'Your roster, including your D/ST' },
  { key: 'watchlist', label: 'Watchlist', hint: 'Players you are tracking' },
]

const scope = ref('league')
const articles = ref([])
const error = ref(null)

// Player search: picking a suggestion pins the feed to one player; typing
// without picking falls back to a headline text search.
const searchText = ref('')
const suggestions = ref([])
const selectedPlayer = ref(null)
const searching = ref(false)

// The search term actually being queried, updated on a debounce. Kept separate
// from `searchText` so typing doesn't fire a request per keystroke.
const committedSearch = ref('')

const activeQuery = computed(() => {
  if (selectedPlayer.value) return { scope: 'player', playerId: selectedPlayer.value.id }
  if (committedSearch.value.length >= 2) return { scope: 'league', q: committedSearch.value }
  return { scope: scope.value }
})

// Your own player ids, so roster hits can be highlighted in the league feed.
// Fetched once — a roster changes far more slowly than the news does.
const myPlayerIds = ref(new Set())
// Tracked separately from the set being non-empty: a genuinely empty roster
// would otherwise re-fetch on every poll forever.
let rosterLoaded = false

async function loadMyRoster() {
  if (rosterLoaded) return
  rosterLoaded = true
  try {
    // The endpoint wraps the roster: { team, lockState, roster }.
    const { roster } = await api.roster()
    const ids = [
      ...roster.starters.map((s) => s.player?.id),
      ...roster.bench.map((p) => p.id),
      ...(roster.ir || []).map((p) => p.id),
    ].filter(Boolean)
    myPlayerIds.value = new Set(ids)
  } catch {
    // Non-essential decoration; the feed works fine without it.
  }
}

const PAGE_SIZE = 30
const hasMore = ref(true)
const loadingMore = ref(false)

/**
 * Merge by id rather than replace.
 *
 * A background poll only ever asks for the newest page, so replacing would
 * throw away every older page the reader had loaded — scrolling back would
 * undo itself once a minute.
 */
function mergeArticles(incoming) {
  const byId = new Map(articles.value.map((a) => [a.id, a]))
  for (const a of incoming) byId.set(a.id, a)
  articles.value = [...byId.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
}

async function load() {
  // Capture the query this request belongs to. A poll for the previous filter
  // can land after the filter has changed, and merging it would show articles
  // that don't belong to what the page now says it is showing.
  const query = activeQuery.value
  const issuedFor = JSON.stringify(query)
  const payload = await api.news({ ...query, limit: PAGE_SIZE })
  if (JSON.stringify(activeQuery.value) !== issuedFor) return

  mergeArticles(payload.articles)
  // A short first page means the archive holds nothing older for this filter.
  if (payload.articles.length < PAGE_SIZE) hasMore.value = false
  error.value = null
  await loadMyRoster()
}

/** Page backwards from the oldest article on screen. */
async function loadMore() {
  if (loadingMore.value || !hasMore.value || !articles.value.length) return
  const query = activeQuery.value
  const issuedFor = JSON.stringify(query)
  const oldest = articles.value[articles.value.length - 1]

  loadingMore.value = true
  try {
    const payload = await api.news({ ...query, limit: PAGE_SIZE, before: oldest.publishedAt })
    if (JSON.stringify(activeQuery.value) !== issuedFor) return
    if (payload.articles.length) mergeArticles(payload.articles)
    if (payload.articles.length < PAGE_SIZE) hasMore.value = false
  } catch (err) {
    error.value = err.message
  } finally {
    loadingMore.value = false
  }
}

const live = useLive(
  async () => {
    try {
      await load()
    } catch (err) {
      error.value = err.message
    }
  },
  { intervalMs: 60_000 },
)

// A minute is plenty for news — it is not a live scoreboard, and the ingest
// itself only runs every 15 minutes, so polling faster would just re-fetch
// identical rows.

/**
 * One refresh per distinct query, and only one.
 *
 * Watching a single derived key rather than each input matters: changing the
 * scope also clears the search box, so watching both fired twice — and useLive
 * drops a refresh that arrives while another is in flight, which left the feed
 * showing league articles under a "My team" heading. Vue batches watchers to
 * the next tick, so all the synchronous state changes collapse into one fetch.
 */
const queryKey = computed(() => JSON.stringify(activeQuery.value))
watch(queryKey, async () => {
  // Reset the accumulated pages — they belong to the previous filter.
  articles.value = []
  hasMore.value = true
  // Deliberately not live.refresh(): that skips when a poll is already in
  // flight, which would leave the list empty with nothing scheduled to fill it.
  try {
    await load()
  } catch (err) {
    error.value = err.message
  }
})

let debounce
// Set when the box is filled programmatically (picking a suggestion), so that
// write doesn't look like typing and immediately reopen the dropdown.
let suppressSearch = false

watch(searchText, (value) => {
  clearTimeout(debounce)
  if (suppressSearch) {
    suppressSearch = false
    return
  }
  const term = value.trim()

  // Typing a fresh query clears a pinned player, otherwise the feed would stay
  // stuck on the previous pick while the box says something else.
  if (selectedPlayer.value && term !== selectedPlayer.value.name) selectedPlayer.value = null

  if (term.length < 2) {
    suggestions.value = []
    committedSearch.value = ''
    return
  }

  debounce = setTimeout(async () => {
    searching.value = true
    try {
      // No availability filter: news about a player matters whether they are
      // on your bench, someone else's, or nobody's.
      const res = await api.searchPlayers({ search: term, limit: 6 })
      suggestions.value = (res.players || []).slice(0, 6).map((p) => ({
        id: p.id,
        name: p.full_name,
        position: p.position,
        nflTeam: p.nfl_team,
      }))
    } catch {
      suggestions.value = []
    } finally {
      searching.value = false
    }
    committedSearch.value = term
  }, 300)
})
onUnmounted(() => clearTimeout(debounce))

function pickPlayer(player) {
  suppressSearch = true
  selectedPlayer.value = player
  searchText.value = player.name
  committedSearch.value = ''
  suggestions.value = []
}

// These only set state — the queryKey watcher issues the single refresh.
function clearSearch() {
  clearTimeout(debounce)
  selectedPlayer.value = null
  searchText.value = ''
  committedSearch.value = ''
  suggestions.value = []
}

function setScope(key) {
  clearSearch()
  scope.value = key
}

/**
 * Which player tags to show on a card.
 *
 * ESPN's fantasy roundups tag everybody — one of them carried 54 players — and
 * rendering all of them buries the feed under a wall of chips. Your own players
 * sort first so a roster hit is the thing you see, and the rest collapse into a
 * count.
 */
const TAG_LIMIT = 6

function visibleTags(item) {
  const mine = item.players.filter((p) => myPlayerIds.value.has(p.id))
  const others = item.players.filter((p) => !myPlayerIds.value.has(p.id))
  const ordered = [...mine, ...others]
  return { shown: ordered.slice(0, TAG_LIMIT), extra: Math.max(0, ordered.length - TAG_LIMIT) }
}

/** Relative time, falling back to a date once an article is over a week old. */
function published(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const days = (Date.now() - then.getTime()) / 86_400_000
  if (days < 1) return agoLabel(then)
  if (days < 7) return `${Math.round(days)}d ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const emptyMessage = computed(() => {
  if (selectedPlayer.value) return `No recent stories mentioning ${selectedPlayer.value.name}.`
  if (committedSearch.value.length >= 2) return `Nothing matching “${committedSearch.value}”.`
  if (scope.value === 'watchlist') return 'Nothing yet. Add players to your watchlist on the Acquisitions tab.'
  if (scope.value === 'team') return 'No stories about your roster right now — a quiet week is a good week.'
  return 'No news loaded yet. It refreshes automatically every 15 minutes.'
})

const heading = computed(() => {
  if (selectedPlayer.value) return `News about ${selectedPlayer.value.name}`
  if (committedSearch.value.length >= 2) return `Search: “${committedSearch.value}”`
  return SCOPES.find((s) => s.key === scope.value)?.hint || ''
})

</script>

<template>
  <div class="stack">
    <div class="card">
      <div class="card-header">
        <h2>NFL News</h2>
        <span v-if="live.lastUpdated.value" class="tiny faint">
          updated {{ agoLabel(live.lastUpdated.value) }}
        </span>
      </div>

      <div class="card-body stack">
        <div class="filters">
          <button
            v-for="item in SCOPES"
            :key="item.key"
            class="chip"
            :class="{ active: !selectedPlayer && committedSearch.length < 2 && scope === item.key }"
            type="button"
            @click="setScope(item.key)"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="search-wrap">
          <input
            v-model="searchText"
            class="search"
            type="search"
            placeholder="Search a player or a headline…"
            aria-label="Search news"
          />
          <button v-if="searchText" class="btn btn-ghost btn-sm clear" type="button" @click="clearSearch">
            Clear
          </button>

          <ul v-if="suggestions.length" class="suggestions">
            <li v-for="p in suggestions" :key="p.id">
              <button type="button" @click="pickPlayer(p)">
                <span class="pill pill-pos">{{ p.position }}</span>
                <span class="sug-name">{{ p.name }}</span>
                <span class="tiny faint">{{ p.nflTeam || 'FA' }}</span>
              </button>
            </li>
          </ul>
        </div>

        <p class="tiny faint heading-hint">{{ heading }}</p>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="!articles.length" class="card">
      <div class="card-body">
        <p class="faint center empty">{{ emptyMessage }}</p>
      </div>
    </div>

    <article v-for="item in articles" :key="item.id" class="card news-card">
      <a
        class="news-link"
        :class="{ 'no-thumb': !item.imageUrl }"
        :href="item.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img v-if="item.imageUrl" class="thumb" :src="item.imageUrl" :alt="''" loading="lazy" />
        <div class="body">
          <h3 class="headline">{{ item.headline }}</h3>
          <p v-if="item.description" class="small desc">{{ item.description }}</p>
          <div class="meta tiny faint">
            <span>{{ published(item.publishedAt) }}</span>
            <span v-if="item.byline">· {{ item.byline }}</span>
            <span v-if="item.type === 'Media' || item.type === 'Video'" class="pill pill-info">Video</span>
          </div>
        </div>
      </a>

      <div v-if="item.players.length || item.teams.length" class="tags">
        <button
          v-for="p in visibleTags(item).shown"
          :key="p.id"
          class="tag"
          :class="{ mine: myPlayerIds.has(p.id) }"
          type="button"
          :title="`See all news about ${p.name}`"
          @click="pickPlayer({ id: p.id, name: p.name, position: p.position })"
        >
          {{ p.name }}
        </button>
        <span v-if="visibleTags(item).extra" class="tag more">
          +{{ visibleTags(item).extra }} more
        </span>
        <span v-for="t in item.teams.slice(0, 3)" :key="t" class="tag team">{{ t }}</span>
      </div>
    </article>

    <div v-if="articles.length" class="load-more">
      <button v-if="hasMore" class="btn" type="button" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
      <p v-else class="tiny faint end-note">
        That's everything stored for this filter. The archive grows as news comes in.
      </p>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.chip {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.chip:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.chip.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-hover);
}

.search-wrap {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.4rem;
  align-items: center;
}

.search {
  width: 100%;
  min-width: 0;
}

.clear {
  flex-shrink: 0;
}

.suggestions {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 0;
  right: 0;
  z-index: 10;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
}

.suggestions button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.suggestions button:hover {
  background: var(--surface-hover);
}

.sug-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.heading-hint {
  margin: 0;
}

.empty {
  margin: 0.5rem 0;
}

.news-card {
  overflow: hidden;
}

.news-link {
  display: grid;
  /* minmax(0,…) rather than 1fr: an auto minimum is min-content, which lets a
     long unbroken headline push the page wider than the viewport on a phone. */
  grid-template-columns: 7rem minmax(0, 1fr);
  gap: 0.85rem;
  padding: 0.85rem;
  color: inherit;
}

/* Not every article ships an image; without this the thumbnail column stays
   reserved and the text sits in a column of empty space. */
.news-link.no-thumb {
  grid-template-columns: minmax(0, 1fr);
}

.news-link:hover {
  background: var(--surface-hover);
  text-decoration: none;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 0.25rem 0 0.5rem;
}

.end-note {
  margin: 0;
  text-align: center;
}

.news-link:hover .headline {
  color: var(--accent-hover);
}

.thumb {
  width: 7rem;
  height: 4.5rem;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}

.body {
  min-width: 0;
}

.headline {
  margin: 0 0 0.25rem;
  font-size: 0.95rem;
  line-height: 1.35;
}

.desc {
  margin: 0 0 0.35rem;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0 0.85rem 0.75rem;
}

.tag {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-inset);
  color: var(--text-muted);
  font-size: 0.7rem;
  cursor: pointer;
}

.tag:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

/* Your own players stand out, so a roster hit is obvious while scrolling the
   league-wide feed. */
.tag.mine {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-weight: 600;
}

.tag.team,
.tag.more {
  cursor: default;
}

.tag.more {
  border-style: dashed;
  color: var(--text-faint);
}

@media (max-width: 620px) {
  .news-link {
    grid-template-columns: 4.5rem minmax(0, 1fr);
    gap: 0.6rem;
    padding: 0.7rem;
  }

  .thumb {
    width: 4.5rem;
    height: 3.2rem;
  }

  .headline {
    font-size: 0.9rem;
  }

  .desc {
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
}
</style>
