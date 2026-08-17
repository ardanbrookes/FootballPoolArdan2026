import { Hono } from 'hono'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { getServerConfig } from '../config.js'
import { authenticate, createSession, destroySession, getUserTeams, SESSION_COOKIE } from '../services/auth.js'

const router = new Hono()

router.post('/login', async (c) => {
  const { username, password } = c.get('body') || {}
  if (!username || !password) return c.json({ error: 'Username and password are required.' }, 400)

  const user = await authenticate(username, password)
  if (!user) return c.json({ error: 'Incorrect username or password.' }, 401)

  const { sessionTtlDays, isProduction } = getServerConfig()
  const { token, expiresAt } = await createSession(user.id)

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: sessionTtlDays * 86_400,
  })

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      isCommissioner: Boolean(user.is_commissioner),
    },
    teams: await getUserTeams(user.id),
    expiresAt,
  })
})

router.post('/logout', async (c) => {
  await destroySession(getCookie(c, SESSION_COOKIE))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

router.get('/me', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ user: null, teams: [] })
  return c.json({ user, teams: await getUserTeams(user.id) })
})

export default router
