<script setup>
import { onMounted, ref, computed } from 'vue'
import { useSessionStore, useLeagueStore } from '@/stores/league.js'
import DeadlineTimer from '@/components/DeadlineTimer.vue'

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
  { to: '/acquisitions', label: 'Acquisitions' },
  { to: '/trades', label: 'Trades' },
  { to: '/league', label: 'League' },
  { to: '/rules', label: 'Rules' },
]

const deadline = computed(() => league.lockState?.nextDeadline)
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
        <p class="tiny faint center" style="margin: 0">
          Demo league — password is <code>football</code>
        </p>
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
          <DeadlineTimer v-if="deadline" :deadline="deadline" compact @elapsed="league.refreshLocks()" />
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
  .topbar-right :deep(.timer) {
    display: none;
  }
}
</style>
