/**
 * Keep a view's data fresh without the user reloading.
 *
 * Polling rather than websockets: Cloudflare Workers can only hold a persistent
 * connection through Durable Objects, which is a lot of machinery for eight
 * people checking scores. A few requests a minute costs nothing on the free
 * tier and has no connection state to go wrong.
 *
 * Two things stop it being wasteful:
 *   - it pauses entirely while the tab is hidden, and refreshes once on return,
 *     so a tab left open overnight makes no requests
 *   - overlapping runs are skipped, so a slow response can't stack up
 *
 * Usage:
 *   const live = useLive(loadEverything, { intervalMs: 10000 })
 *   live.refresh()        // manual, e.g. a refresh button
 *   live.lastUpdated      // ref<Date|null>, for "updated 12s ago"
 */

import { ref, onMounted, onUnmounted } from 'vue'

export function useLive(loader, { intervalMs = 15000, immediate = true } = {}) {
  const lastUpdated = ref(null)
  const refreshing = ref(false)
  const error = ref(null)

  let timer = null
  let inFlight = false
  let stopped = false

  async function run({ manual = false } = {}) {
    // A slow poll shouldn't queue another behind it.
    if (inFlight || stopped) return
    inFlight = true
    if (manual) refreshing.value = true

    try {
      await loader()
      lastUpdated.value = new Date()
      error.value = null
    } catch (err) {
      // Background failures stay quiet — a dropped poll isn't worth an alert —
      // but a manual refresh should say what went wrong.
      if (manual) error.value = err.message
    } finally {
      inFlight = false
      refreshing.value = false
    }
  }

  const refresh = () => run({ manual: true })

  function start() {
    stop()
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') run()
    }, intervalMs)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function onVisibility() {
    // Catch up immediately on return rather than waiting out the interval.
    if (document.visibilityState === 'visible') run()
  }

  onMounted(() => {
    if (immediate) run()
    start()
    document.addEventListener('visibilitychange', onVisibility)
  })

  onUnmounted(() => {
    stopped = true
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { lastUpdated, refreshing, error, refresh }
}

/** "just now" / "12s ago" / "3m ago", for a last-updated caption. */
export function agoLabel(date, now = Date.now()) {
  if (!date) return ''
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
