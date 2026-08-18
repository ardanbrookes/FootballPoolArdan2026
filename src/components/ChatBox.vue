<script setup>
/**
 * League chat and event feed.
 *
 * People's messages and the league's own events share one stream, so a waiver
 * claim and the gloating about it sit next to each other.
 *
 * GIFs: a pasted Tenor/Giphy/image link renders inline. That covers the usual
 * "paste a reaction gif" flow without needing an API key or a picker UI.
 */
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import api from '@/api/client.js'
import { useLive, agoLabel } from '@/composables/useLive.js'

const props = defineProps({
  /** Poll interval in ms. Chat is the one thing people watch, so it's brisk. */
  pollMs: { type: Number, default: 8000 },
})

const messages = ref([])
const draft = ref('')
const sending = ref(false)
const error = ref(null)
const scroller = ref(null)

/** Ticks once a second purely so the "updated Xs ago" caption counts up. */
const nowTick = ref(Date.now())
let clockTimer

/** Direct image/GIF links render inline; everything else stays text. */
const IMAGE_RE = /https?:\/\/\S+\.(?:gif|gifv|png|jpe?g|webp)(?:\?\S*)?/i
/** Tenor and Giphy share pages aren't direct links, so offer them as a link out. */
const GIF_PAGE_RE = /https?:\/\/(?:\w+\.)?(?:tenor\.com|giphy\.com)\/\S+/i

function parse(body) {
  const image = body.match(IMAGE_RE)?.[0] ?? null
  const gifPage = !image ? (body.match(GIF_PAGE_RE)?.[0] ?? null) : null
  const text = body.replace(image ?? gifPage ?? '', '').trim()
  return { text, image, gifPage }
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
})
onUnmounted(() => clearInterval(clockTimer))
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
            <span v-if="item.teamAbbr" class="pill pill-pos tiny">{{ item.teamAbbr }}</span>
            <span class="tiny faint time">{{ time(item.createdAt) }}</span>
          </div>
          <div class="msg-body small">
            <span v-if="parse(item.body).text">{{ parse(item.body).text }}</span>
            <img
              v-if="parse(item.body).image"
              :src="parse(item.body).image"
              alt=""
              class="msg-gif"
              loading="lazy"
            />
            <a
              v-else-if="parse(item.body).gifPage"
              :href="parse(item.body).gifPage"
              target="_blank"
              rel="noopener"
              class="tiny"
            >
              {{ parse(item.body).gifPage }} ↗
            </a>
          </div>
        </div>
      </template>
    </div>

    <div v-if="error" class="alert alert-error tiny" style="margin: 0 0.75rem 0.5rem">{{ error }}</div>

    <form class="composer" @submit.prevent="send">
      <input
        v-model="draft"
        placeholder="Say something, or paste a GIF link…"
        maxlength="1000"
        :disabled="sending"
      />
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
</style>
