<script setup>
/**
 * League chat and event feed.
 *
 * People's messages and the league's own events share one stream, so a waiver
 * claim and the gloating about it sit next to each other.
 *
 * GIFs come from a picker backed by a fixed pack (see data/gifs.js). Pasting a
 * link used to be the mechanism, but a Tenor or Giphy share link is a web page
 * rather than an image, so the usual copy-from-the-app flow posted bare text
 * and nothing ever appeared.
 */
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import api from '@/api/client.js'
import { useLive, agoLabel } from '@/composables/useLive.js'
import { gifCategories, stillUrl, animatedUrl, GIF_URL_RE } from '@/data/gifs.js'

const props = defineProps({
  /**
   * Poll interval in ms.
   *
   * Chat is the one thing people watch, but every poll is a database read per
   * open tab — at eight seconds this alone was a large share of the daily read
   * allowance. Twenty still feels live.
   */
  pollMs: { type: Number, default: 20000 },
})

const messages = ref([])
const draft = ref('')
const sending = ref(false)
const error = ref(null)
const scroller = ref(null)

/** Ticks once a second purely so the "updated Xs ago" caption counts up. */
const nowTick = ref(Date.now())
let clockTimer

/**
 * A message is either a GIF from the picker or plain text.
 *
 * Only URLs the picker itself produces render as images — arbitrary pasted
 * links stay as text, so nobody can drop a surprise image into the feed.
 */
function parse(body) {
  const trimmed = (body || '').trim()
  if (GIF_URL_RE.test(trimmed)) return { text: '', gif: trimmed }
  return { text: body, gif: null }
}

const pickerOpen = ref(false)
const gifSearch = ref('')

const visibleGifs = computed(() => {
  const term = gifSearch.value.trim().toLowerCase()
  if (!term) return gifCategories
  return gifCategories.filter((c) => c.label.toLowerCase().includes(term))
})

async function sendGif(id) {
  pickerOpen.value = false
  gifSearch.value = ''
  sending.value = true
  error.value = null
  try {
    // Posted as its own message rather than appended to the draft, so a GIF is
    // always a whole reaction and never half a sentence.
    await api.postChat(animatedUrl(id))
    await load({ scroll: true })
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}

/** Clicking away or pressing Escape closes the picker. */
function onDocClick(event) {
  if (!event.target.closest?.('.gif-area')) pickerOpen.value = false
}
function onKey(event) {
  if (event.key === 'Escape') pickerOpen.value = false
}

const EVENT_ICON = {
  phase: '⏱',
  trade: '⇄',
  add: '+',
  drop: '−',
  waiver: '✓',
  ir: '✚',
}

/**
 * Only scroll when the stream actually grew, or when explicitly asked. Snapping
 * to the bottom on every poll would fight anyone reading back through history.
 */
async function load({ scroll = false } = {}) {
  const data = await api.chat()
  const grew = data.messages.length !== messages.value.length
  messages.value = data.messages
  if (scroll || grew) await scrollToBottom()
}

const live = useLive(load, { intervalMs: props.pollMs, immediate: false })

async function scrollToBottom() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

async function send() {
  const body = draft.value.trim()
  if (!body || sending.value) return
  sending.value = true
  error.value = null
  try {
    await api.postChat(body)
    draft.value = ''
    await load({ scroll: true })
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}

const time = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const day = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** Insert a date divider whenever the day changes. */
const withDividers = computed(() => {
  const out = []
  let lastDay = null
  for (const m of messages.value) {
    const d = day(m.createdAt)
    if (d !== lastDay) {
      out.push({ divider: true, id: `d-${d}`, label: d })
      lastDay = d
    }
    out.push(m)
  }
  return out
})

const updatedLabel = computed(() => agoLabel(live.lastUpdated.value, nowTick.value))

onMounted(async () => {
  await load({ scroll: true }).catch((err) => (error.value = err.message))
  live.lastUpdated.value = new Date()
  clockTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  clearInterval(clockTimer)
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="card chat">
    <div class="card-header">
      <h2>League chat</h2>
      <div class="row">
        <span class="tiny faint">{{ updatedLabel }}</span>
        <button
          class="btn btn-ghost btn-sm refresh"
          :class="{ spinning: live.refreshing.value }"
          title="Refresh now"
          :disabled="live.refreshing.value"
          @click="live.refresh()"
        >
          ↻
        </button>
      </div>
    </div>

    <div ref="scroller" class="stream">
      <div v-if="messages.length === 0" class="empty small">
        Nothing yet. Trades, signings, drops and deadline changes show up here automatically.
      </div>

      <template v-for="item in withDividers" :key="item.id">
        <div v-if="item.divider" class="divider tiny faint">{{ item.label }}</div>

        <div v-else-if="item.kind === 'system'" class="msg system">
          <span class="ev-icon" :class="`ev-${item.eventType}`">{{ EVENT_ICON[item.eventType] ?? '•' }}</span>
          <div class="sys-body">
            <span class="small">{{ item.body }}</span>
            <span class="tiny faint time">{{ time(item.createdAt) }}</span>
          </div>
        </div>

        <div v-else class="msg">
          <div class="msg-head">
            <span class="small bold">{{ item.author }}</span>
            <span v-if="item.teamName" class="pill pill-pos tiny">{{ item.teamName }}</span>
            <span class="tiny faint time">{{ time(item.createdAt) }}</span>
          </div>
          <div class="msg-body small">
            <span v-if="parse(item.body).text">{{ parse(item.body).text }}</span>
            <img
              v-if="parse(item.body).gif"
              :src="parse(item.body).gif"
              alt="GIF"
              class="msg-gif"
            />
          </div>
        </div>
      </template>
    </div>

    <div v-if="error" class="alert alert-error tiny" style="margin: 0 0.75rem 0.5rem">{{ error }}</div>

    <form class="composer" @submit.prevent="send">
      <div class="gif-area">
        <button
          type="button"
          class="btn btn-ghost btn-sm gif-toggle"
          :class="{ on: pickerOpen }"
          :disabled="sending"
          :aria-expanded="pickerOpen"
          title="Send a GIF"
          @click="pickerOpen = !pickerOpen"
        >
          GIF
        </button>

        <div v-if="pickerOpen" class="picker">
          <input
            v-model="gifSearch"
            class="picker-search"
            type="search"
            placeholder="Filter reactions…"
            aria-label="Filter reactions"
          />
          <div class="picker-scroll">
            <div v-for="cat in visibleGifs" :key="cat.label" class="picker-group">
              <div class="tiny faint picker-label">{{ cat.label }}</div>
              <div class="picker-grid">
                <button
                  v-for="id in cat.ids"
                  :key="id"
                  type="button"
                  class="picker-tile"
                  :title="cat.label"
                  @click="sendGif(id)"
                >
                  <!-- Stills here, animated on send: 48 animated tiles would be
                       ~14 MB, the stills are ~11 KB each.

                       Deliberately NOT lazy. The whole grid is ~670 KB of
                       stills, it only exists while the picker is open, and
                       eager loading means a tile is never a blank square
                       waiting on viewport detection. -->
                  <img :src="stillUrl(id)" :alt="cat.label" />
                </button>
              </div>
            </div>
            <p v-if="!visibleGifs.length" class="tiny faint picker-empty">
              Nothing matching “{{ gifSearch }}”.
            </p>
          </div>
        </div>
      </div>

      <input v-model="draft" placeholder="Say something…" maxlength="1000" :disabled="sending" />
      <button class="btn btn-primary btn-sm" type="submit" :disabled="!draft.trim() || sending">
        {{ sending ? '…' : 'Send' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
}

.stream {
  flex: 1;
  min-height: 14rem;
  max-height: 26rem;
  overflow-y: auto;
  padding: 0.5rem 0;
}

.divider {
  text-align: center;
  padding: 0.4rem 0 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.msg {
  padding: 0.3rem 0.85rem;
}

.msg-head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.time {
  margin-left: auto;
  flex-shrink: 0;
}

.msg-body {
  margin-top: 0.1rem;
  overflow-wrap: anywhere;
}

.msg-gif {
  display: block;
  margin-top: 0.35rem;
  max-width: min(100%, 18rem);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

/* System posts read as league record, not conversation. */
.msg.system {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  background: var(--bg-inset);
  border-left: 2px solid var(--border-strong);
  padding: 0.35rem 0.85rem;
  margin: 0.15rem 0;
}

.sys-body {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
}

.ev-icon {
  display: grid;
  place-items: center;
  width: 1.15rem;
  height: 1.15rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  background: var(--surface);
  color: var(--text-muted);
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.ev-add {
  color: var(--accent-hover);
}
.ev-drop {
  color: var(--danger);
}
.ev-trade {
  color: var(--info);
}
.ev-phase {
  color: var(--warn);
}

.refresh {
  font-size: 0.95rem;
  line-height: 1;
  padding: 0.15rem 0.35rem;
}

.refresh.spinning {
  animation: spin 0.7s linear infinite;
}

.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-top: 1px solid var(--border);
  background: var(--bg-inset);
}

/* The composer's text input must be free to shrink, or the GIF button and Send
   push the row wider than the card on a phone. */
.composer input:not(.picker-search) {
  flex: 1;
  min-width: 0;
}

.gif-area {
  position: relative;
  flex-shrink: 0;
}

.gif-toggle {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  height: 100%;
}

.gif-toggle.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-hover);
}

/* Opens upward — the composer sits at the bottom of the card. */
.picker {
  position: absolute;
  bottom: calc(100% + 0.4rem);
  left: 0;
  z-index: 30;
  width: min(20rem, calc(100vw - 2.5rem));
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.picker-search {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg-inset);
}

.picker-scroll {
  max-height: 17rem;
  overflow-y: auto;
  padding: 0.5rem;
}

.picker-group + .picker-group {
  margin-top: 0.5rem;
}

.picker-label {
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.3rem;
}

.picker-tile {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  cursor: pointer;
  overflow: hidden;
  aspect-ratio: 4 / 3;
}

.picker-tile:hover {
  border-color: var(--accent);
}

.picker-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.picker-empty {
  margin: 0.5rem 0;
  text-align: center;
}
</style>
