<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useSessionStore, useLeagueStore } from '@/stores/league.js'

const session = useSessionStore()
const league = useLeagueStore()

const username = ref('')
const password = ref('')
const loginError = ref(null)
const signingIn = ref(false)

onMounted(async () => {
  await session.load()
  if (session.isSignedIn) await league.load()
})

async function signIn() {
  signingIn.value = true
  loginError.value = null
  try {
    await session.login(username.value, password.value)
    await league.load()
  } catch (err) {
    loginError.value = err.message
  } finally {
    signingIn.value = false
  }
}

async function signOut() {
  await session.logout()
}

const navItems = [
  { to: '/', label: 'Home' },
  { to: '/league', label: 'League' },
  { to: '/acquisitions', label: 'Acquisitions' },
  { to: '/trades', label: 'Trades' },
  { to: '/news', label: 'News' },
  { to: '/rules', label: 'Rules' },
]

const deadline = computed(() => league.lockState?.nextDeadline)

/**
 * Live countdown to the next deadline.
 *
 * Ticks locally rather than re-fetching, and asks the store to re-check the
 * phase once it reaches zero — the phase change happens server-side, so the
 * clock hitting 00:00 is the cue to go and confirm it.
 */
const nowTick = ref(Date.now())
let clockTimer

const countdown = computed(() => {
  const at = deadline.value?.at
  if (!at) return ''
  const remaining = Math.max(0, Date.parse(at) - nowTick.value)
  if (remaining === 0) return 'now'

  const total = Math.floor(remaining / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n) => String(n).padStart(2, '0')

  return days ? `${days}d ${pad(hours)}:${pad(minutes)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
})

/** Under three hours reads as urgent — that's when people miss deadlines. */
const urgent = computed(() => {
  const at = deadline.value?.at
  if (!at) return false
  const remaining = Date.parse(at) - nowTick.value
  return remaining > 0 && remaining < 3 * 3600 * 1000
})

onMounted(() => {
  clockTimer = setInterval(() => {
    const before = nowTick.value
    nowTick.value = Date.now()
    // Crossed the deadline: the server decides the new phase, so go and ask.
    const at = deadline.value?.at
    if (at && Date.parse(at) > before && Date.parse(at) <= nowTick.value) league.refreshLocks()
  }, 1000)
})
onUnmounted(() => clearInterval(clockTimer))
</script>

<template>
  <div v-if="!session.ready" class="boot">
    <div class="spinner" />
  </div>

  <div v-else-if="!session.isSignedIn" class="signin">
    <form class="card signin-card" @submit.prevent="signIn">
      <div class="card-header"><h2>Football Pool 2026</h2></div>
      <div class="card-body stack">
        <div>
          <label for="u">Manager</label>
          <input id="u" v-model="username" autocomplete="username" placeholder="e.g. ardan" />
        </div>
        <div>
          <label for="p">Password</label>
          <input id="p" v-model="password" type="password" autocomplete="current-password" />
        </div>
        <div v-if="loginError" class="alert alert-error">{{ loginError }}</div>
        <button class="btn btn-primary" type="submit" :disabled="signingIn">
          {{ signingIn ? 'Signing in…' : 'Sign in' }}
        </button>
      </div>
    </form>
  </div>

  <div v-else class="shell">
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="brand">
          <span class="brand-mark">FP</span>
          <div>
            <div class="brand-name">{{ league.league?.name || 'Football Pool' }}</div>
            <div class="tiny faint">
              Week {{ league.currentWeek }} · {{ league.myTeam?.name || session.user.displayName }}
            </div>
          </div>
        </div>

        <div class="topbar-right">
          <!-- What phase we're in and exactly when it changes. Applies to every
               page, so it belongs here rather than on Home. -->
          <div v-if="league.lockState" class="phase-block">
            <div class="phase-row">
              <span class="phase-name" :class="`phase-${league.lockState.phase}`">
                {{ league.lockState.phaseLabel }}
              </span>
              <span v-if="deadline" class="countdown mono" :class="{ urgent }">{{ countdown }}</span>
            </div>
            <div v-if="deadline" class="tiny faint phase-until">
              {{ deadline.title }} · {{ deadline.label }}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="signOut">Sign out</button>
        </div>
      </div>

      <nav class="nav">
        <div class="container nav-inner">
          <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="nav-link">
            {{ item.label }}
          </RouterLink>
        </div>
      </nav>
    </header>

    <main class="container main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.boot,
.signin {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.signin-card {
  width: 100%;
  max-width: 22rem;
}

.topbar {
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}

.topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 0.7rem;
  padding-bottom: 0.7rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #06120c;
  font-weight: 700;
  font-size: 0.8rem;
  flex-shrink: 0;
}

.brand-name {
  font-weight: 600;
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;
}

.phase-block {
  text-align: right;
  min-width: 0;
}

.phase-row {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 0.5rem;
}

.countdown {
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text);
}

.countdown.urgent {
  color: var(--warn);
}

.phase-name {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  line-height: 1.2;
  color: var(--text-muted);
}

/* Colour carries the same meaning as the Acquisitions banner: green means you
   can move players, amber means partially, red means frozen. */
.phase-name.phase-open,
.phase-name.phase-preseason {
  color: var(--accent-hover);
}

.phase-name.phase-early_game_lock,
.phase-name.phase-waiver_period {
  color: var(--warn);
}

.phase-name.phase-blanket_lock {
  color: var(--danger);
}

.phase-until {
  white-space: nowrap;
}

.nav {
  border-top: 1px solid var(--border);
  overflow-x: auto;
}

.nav-inner {
  display: flex;
  gap: 0.25rem;
}

.nav-link {
  padding: 0.6rem 0.85rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.nav-link:hover {
  color: var(--text);
  text-decoration: none;
}

.nav-link.router-link-exact-active {
  color: var(--accent-hover);
  border-bottom-color: var(--accent);
}

.main {
  padding-top: 1.25rem;
  padding-bottom: 3rem;
}

@media (max-width: 620px) {
  /* Keep the phase name and the countdown on a phone — between them they say
     what you can do and how long you have. The full changeover date doesn't
     fit alongside, and is available on Acquisitions anyway. */
  .phase-until {
    display: none;
  }

  .phase-name {
    font-size: 0.65rem;
  }

  .countdown {
    font-size: 0.85rem;
  }

  .phase-row {
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
  }
}
</style>
