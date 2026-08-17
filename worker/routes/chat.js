import { Hono } from 'hono'
import { get } from '../db.js'
import { loadLeague, requireUser } from '../middleware/auth.js'
import { listMessages, postMessage } from '../services/chat.js'

const router = new Hono()
router.use('*', loadLeague)

/** Recent messages, oldest first. `?before=<iso>` pages backwards. */
router.get('/', requireUser, async (c) => {
  const league = c.get('league')
  return c.json({
    messages: await listMessages(league.id, {
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      before: c.req.query('before') || null,
    }),
  })
})

/** Post a message. Body: { body } */
router.post('/', requireUser, async (c) => {
  const league = c.get('league')
  const user = c.get('user')
  const { body } = c.get('body') || {}

  // Attach the poster's team so the feed can show a tag next to their name.
  const team = await get('SELECT id FROM teams WHERE league_id = @leagueId AND user_id = @userId', {
    leagueId: league.id,
    userId: user.id,
  })

  const message = await postMessage({
    leagueId: league.id,
    userId: user.id,
    teamId: team?.id ?? null,
    body,
  })

  return c.json({ message }, 201)
})

export default router
