import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/acquisitions', name: 'acquisitions', component: () => import('@/views/AcquisitionsView.vue') },
  { path: '/trades', name: 'trades', component: () => import('@/views/TradesView.vue') },
  { path: '/league', name: 'league', component: () => import('@/views/LeagueView.vue') },
  { path: '/rules', name: 'rules', component: () => import('@/views/RulesView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
