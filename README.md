# Football Pool 2026

A custom fantasy football league for a group of friends. Vue 3 + Vite on the
front, Cloudflare Workers + D1 on the back, NFL data from the public Sleeper API.

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
npm run cf:migrate:local
npm run schedule:build && npm run schedule:load:local
npm run build
npm run dev
```

Then open http://localhost:5173 and sign in as any manager below with the
password `football`:

`ardan` (commissioner), `sam`, `jordan`, `casey`, `riley`, `morgan`, `avery`,
`quinn`, `reese`, `harper`

Seed the demo league once the dev server is up:

```bash
npm run seed:local
```

`npm run dev` runs two processes: Vite on :5173 for the client, and
`wrangler dev` on :8787 running the real Worker against a local D1 database.
Vite proxies `/api` to the Worker, so the dev environment matches production.

> The `npm run build` above is needed because Wrangler requires `dist/` to
> exist for the static-assets binding. You only need to repeat it when you want
> the Worker to serve fresh assets; during development Vite handles the client.

---

## How the league works

### The weekly cycle

All times **Pacific** (`America/Vancouver`, so DST is handled automatically).
This is the core business logic and lives in
[`worker/services/locks.js`](worker/services/locks.js).

| When | Phase (shown as) | What's allowed |
|---|---|---|
| Before the season's first kickoff | **Preseason** | Free agency open, no waivers exist, **no cycle jobs run at all** |
| Tue 03:00 → first kickoff of the week | **Open period** | Adds, drops, swaps, lineups — first come, first served |
| First kickoff → Sun 10:00 | **Game period** | **Only the teams already playing are frozen.** Everyone else stays fully open |
| Sun 10:00 → Monday's final whistle | **Game period** | Everything freezes, trades close, free agents move to waivers. Claims can still be queued |
| Final whistle → Tue 03:00 | **Waiver period** | Scores final, standings updated, rosters and trades reopen. Claims only — no instant pickups |

Four details worth knowing:

- **The Thursday lock is per-team, not league-wide.** If Buffalo plays Detroit on
  Thursday, only Bills and Lions players lock. This is the whole point of the
  compromise, and it's enforced per player on every transaction.
- **The Monday boundary is derived, not scheduled.** It's the last game of the
  week's actual kickoff plus its length plus a 30-minute buffer, so a flexed
  kickoff or a game running long moves it automatically.
- **Sunday's lock is 10:00 Pacific** — the moment the early window kicks off
  (13:00 Eastern). Nothing can be shuffled once any Sunday game is live.
- **A player whose game is in progress is always locked**, regardless of phase.

The active NFL week is derived from the *schedule*, not from a stored counter, so
a missed cron run can't cause the app to lock the wrong teams. If the stored week
and the schedule disagree, the API reports `weekDrift` and the UI shows a warning.

Note the season opener is not necessarily a Thursday — 2026 opens on a
**Wednesday**. Nothing keys off the weekday; the boundary is "first kickoff of
the week", which handles Wednesday, Friday and Saturday games identically.

### Waivers — Time Since Last Claim

The team that has gone longest without winning a claim picks first; a team that
has never won one sorts to the very front. Ties break toward the worse record,
then fewer points scored, then a stable per-team seed.

Processing re-sorts after every award, so winning a claim drops you to the back
and everyone gets a turn before anyone gets seconds. Claims that fail are
reported with a reason ("Claimed by a higher-priority team", "Drop candidate was
no longer on your roster"). Anyone left unclaimed becomes a free agent.

Preview what the next run would do without changing anything:

```bash
curl -b cookies.txt http://localhost:8787/api/league/waivers/preview
```

### Changing the deadlines

Defaults live in `[vars]` in [`wrangler.toml`](wrangler.toml). The commissioner
can also override them at runtime without a redeploy:

```bash
curl -X PUT http://localhost:8787/api/league/settings \
  -H 'content-type: application/json' -b cookies.txt \
  -d '{"key":"timing.waiverProcess","value":{"weekday":3,"hour":2,"minute":30}}'
```

Weekdays are 1 = Monday … 7 = Sunday. Everything is interpreted in
`LEAGUE_TIMEZONE` and adjusts for daylight saving automatically.

To see what would be locked at some future moment:

```
GET /api/league/lock-state?at=2026-09-17T21:00:00
```

---

## Draft night runbook

The plan: draft on Sleeper, then import once and run the season here.

Every command needs the admin token in the current PowerShell window. It does
not persist — set it again in a new one:

```bash
$env:ADMIN_TOKEN = "your-token-here"
```

### A week before — set the Sleeper league up to match

Do this in Sleeper's own settings, before drafting. The import moves players
only; it never changes our scoring or roster rules, so anything that disagrees
has to be reconciled by hand afterwards.

| Setting | Must be |
| --- | --- |
| Teams | 8 |
| Starters | QB, RB, RB, WR, WR, TE, FLEX, D/ST, K |
| Bench | 7 |
| IR slots | 1 |
| Reception points | 0.5 (half PPR) |

### A week before — set up the managers

**This is the step that makes draft night one command.** The importer matches
people by display name, so set each manager's display name here to the name they
use on Sleeper.

```bash
npm run managers -- --template
```

Edit `managers.json`: `displayName` = their Sleeper name, `username` = what they
type to log in here, `password` = theirs. Leave a field blank to keep it as is.
Then preview and apply:

```bash
npm run managers -- --apply
```

```bash
npm run managers -- --apply --commit
```

`managers.json` holds real passwords and is gitignored. Delete it once everyone
has signed in.

### A week before — rehearse

The league exists on Sleeper before the draft does, so the whole import can be
rehearsed with real data. Find the league id from your username:

```bash
npm run import:sleeper -- --user <your-sleeper-username>
```

Then dry-run it. Nothing is written:

```bash
npm run import:sleeper -- --league <league-id>
```

You are looking for **Managers matched: 8** and no `DIFF` rows. Anyone unmatched
is either a display-name mismatch (fix it in `managers.json`) or someone who can
be placed by hand with `--map`, which accepts a Sleeper display name, username or
user id:

```bash
npm run import:sleeper -- --league <league-id> --map Blake=1,Young3Buck=2
```

### Draft night — import

Dry run once more, because rosters have changed since the rehearsal:

```bash
npm run import:sleeper -- --league <league-id>
```

Then commit. This **replaces every roster** in the league:

```bash
npm run import:sleeper -- --league <league-id> --commit --team-names
```

Drop `--team-names` to keep the names you set in `managers.json` instead of the
ones people picked on Sleeper.

### Afterwards

- Undrafted players are **free agents**, not waivers — first come, first served
  until the first Sunday lock. Nobody has to wait for Tuesday.
- Open the League tab and check all 8 rosters look right.
- Anyone over the 16-player limit (only possible if the Sleeper league had deeper
  benches) must drop down before the first lock. The import never drops a pick on
  someone's behalf.
- The import is **not** a running sync. Sleeper has no TSLC waivers, no Monday
  reset and no Thursday partial lock, so from here on this site is the record.

---

## Deploying to Cloudflare

```bash
# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
npm run cf:db:create

# 2. Apply the schema
npm run cf:migrate:remote

# 3. Load the NFL schedule (see "Why the schedule is a file" below)
npm run schedule:build
npm run schedule:load:remote

# 4. Set secrets
npx wrangler secret put SESSION_SECRET   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put ADMIN_TOKEN

# 5. Build and deploy
npm run deploy

# 6. Seed the league
ADMIN_TOKEN=<token> WORKER_URL=https://<your-worker>.workers.dev npm run seed:remote
```

Cost: this fits inside Cloudflare's free tier comfortably — D1's free allowance is
5 GB and millions of reads per day, and a ten-manager league uses a rounding error
of that.

---

## Making changes after launch

Live at **https://football-pool-2026.ardanbrookes.workers.dev**

### 1. Code changes (UI, business logic, routes)

The common case. Test locally, then ship:

```bash
npm run dev          # Vite :5173 + real Worker on local D1 :8787
npm run deploy       # builds the client and pushes the Worker
```

`npm run deploy` runs `npm run build` for you. Deploys are near-instant and
atomic — there's no window where half the app is updated.

### 2. Schema changes

**Order matters.** Apply the migration to the remote database *before* deploying
code that depends on it, or the live app will error until you catch up.

```bash
# 1. Write migrations/0002_whatever.sql (forward-only; never edit 0001)
npm run cf:migrate:local     # apply locally
npm run dev                  # test against it
npm run cf:migrate:remote    # THEN apply to production
npm run deploy               # THEN ship the code
```

Note that `wrangler rollback` reverts the *Worker*, not the database. A bad
migration is not undone by a rollback, so test locally first.

### 3. Schedule refresh (after flex scheduling)

The NFL moves games between time slots late in the season, which changes which
teams lock on Thursday. Re-pull and re-apply — the SQL upserts, so it's safe to
repeat:

```bash
npm run schedule:build
npm run schedule:load:remote
```

No deploy needed; this is data, not code.

### 4. Changing deadlines

Two ways, depending on whether you want it permanent:

- **Runtime, no deploy** — commissioner `PUT /api/league/settings` (see above).
  Takes effect immediately, survives deploys, stored in the database.
- **Permanent default** — edit `[vars]` in `wrangler.toml`, then `npm run deploy`.

### 5. Rotating a secret

No deploy needed — secrets are read at request time:

```bash
npx wrangler secret put SESSION_SECRET   # signs everyone out
npx wrangler secret put ADMIN_TOKEN
```

### If something breaks

```bash
npx wrangler rollback        # revert to the previous Worker version
npm run cf:tail              # stream live logs
```

### Things that will bite you

- **Never run `seed` with `force` against production.** `POST /api/admin/seed?force=1`
  deletes every roster, transaction and result. It is guarded by `ADMIN_TOKEN`
  for exactly this reason.
- **Local and remote are different databases.** `--local` and `--remote` are
  separate worlds; changing `database_id` in `wrangler.toml` also repoints the
  *local* one, which then needs re-migrating and re-seeding.
- **`dist/` must exist for `wrangler dev` to start.** Run `npm run build` once
  after a fresh clone.

---

### Cron

Cloudflare Cron Triggers only run in UTC, so encoding "Tuesday 3am Eastern"
directly would drift by an hour twice a year. Instead the trigger fires every 15
minutes and [`worker/jobs/tick.js`](worker/jobs/tick.js) decides what's actually
due, using the same league clock as the lock rules. Each job records its last run,
so a missed tick (deploy, outage) simply catches up on the next one instead of
being skipped.

Watch it live with `npm run cf:tail`.

---

## Data sources

| Data | Source | Notes |
|---|---|---|
| Players | Sleeper `/players/nfl` | ~1,000 fantasy-relevant players after filtering. Refreshed daily. |
| Season/week | Sleeper `/state/nfl` | |
| Weekly stats | Sleeper `/stats/nfl/regular/{season}/{week}` | Raw stat lines; points computed at read time. |
| Kickoff times | ESPN scoreboard, **via a build-time script** | See below. |
| News | ESPN news API, `site.web.api.espn.com` | Free, no key. Tagged with athletes and teams. **Host matters — see below.** |

### Why the schedule is a generated file

Sleeper's v1 API doesn't publish a schedule (`/schedule/nfl/regular/{season}`
returns 404), so kickoff times come from ESPN's public scoreboard.

**ESPN returns 403 to requests originating from workerd.** Identical requests from
Node succeed, and Sleeper works fine from the Worker, so this is ESPN bot-detection
on the TLS fingerprint — not something a header can fix.

So the schedule is generated in Node and applied as SQL:

```bash
npm run schedule:build          # writes data/schedule-2026.sql
npm run schedule:load:remote
```

This is arguably the better shape regardless: kickoff times drive the
Thursday-night lock, which makes them correctness-critical, and pinning them into
a versioned file removes a live third-party dependency from the hot path. The
generated SQL upserts, so **re-run it after flex-scheduling changes** — those move
games between time slots and therefore change what locks when.

### Scoring

Standard PPR, defined in `scoring` in [`worker/config.js`](worker/config.js).
Points are computed from raw stat lines at read time, so editing the scoring table
re-scores the whole season with no backfill.

---

## Project layout

```
migrations/          D1 schema (plain SQLite DDL)
data/                Generated schedule SQL
scripts/             Node-side tooling (schedule builder, admin CLI wrapper)
worker/
  index.js           Worker entry — fetch + scheduled handlers
  context.js         Request-scoped env/D1 via AsyncLocalStorage
  db.js              D1 helpers: query/get/run/batch
  config.js          League config (roster slots, scoring, timings)
  services/          Business logic — locks, waivers, roster, trades, scoring
  routes/            Hono HTTP routes
  jobs/              Cron dispatcher and the weekly jobs
  seed.js            Demo league builder
src/                 Vue 3 client (views, components, stores)
```

A couple of structural notes:

- **D1 has no interactive transactions.** You can't BEGIN, read, decide, and
  COMMIT across awaits — the only atomic primitive is `batch()`. So mutating flows
  validate everything up front, collect statements, and submit them together. The
  waiver processor is built this way: it resolves the entire run against an
  in-memory simulation, then commits once.
- **The D1 binding travels in AsyncLocalStorage** rather than being threaded
  through every function signature, which keeps the service layer readable.

### Admin endpoints

Operational tasks are HTTP endpoints guarded by `ADMIN_TOKEN`, because Workers
have no CLI process that can hold a D1 binding. `scripts/admin.mjs` wraps them:

```bash
npm run seed:local                       # or: node scripts/admin.mjs seed --force
node scripts/admin.mjs tick              # run the cron dispatcher now
node scripts/admin.mjs tick --job=waivers
node scripts/admin.mjs week-reset
node scripts/admin.mjs sync/players
node scripts/admin.mjs status
```

---

## Security — read before going public

This was built as a private league app and **auth is deliberately minimal**. The
following were consciously deferred and should be addressed before the URL is
shared beyond people you trust:

- **Everyone shares the demo password `football`.** Replace with per-manager
  passwords. There is no signup flow, password reset, or email verification —
  users are created by the seed script.
- **No rate limiting on login.** The login endpoint will happily accept unlimited
  guesses. Cloudflare Rate Limiting Rules can fix this without code changes.
- **`SESSION_SECRET` must be set to a real random value** before deploying. The
  fallback in `config.js` is a known string and is only safe for local dev.
- **`ADMIN_TOKEN` guards destructive endpoints**, including `/api/admin/seed?force=1`,
  which wipes the league. Treat it like a root password.

What *is* handled: passwords are PBKDF2-HMAC-SHA256 (100k iterations, per-user
salt) and never stored or logged in plaintext; sessions are opaque random tokens
stored hashed, in httpOnly cookies, `Secure` in production; password comparison is
constant-time; and every transaction re-checks ownership and locks server-side
rather than trusting the client.

### Keeping secrets out of git

Secrets live in exactly two places, neither of which is the repo:

| | Local dev | Production |
|---|---|---|
| `SESSION_SECRET`, `ADMIN_TOKEN` | `.dev.vars` (gitignored) | `npx wrangler secret put NAME` |

Three layers guard against a leak:

**1. `.gitignore`** covers `.dev.vars`, `.env*`, `*.pem`, `*.key`, SSH keys and
credential dumps. Verify at any time with:

```bash
git check-ignore -v .dev.vars
```

**2. A pre-commit hook** catches what `.gitignore` cannot — a real token pasted
into a file that is *already tracked*, which is the likelier accident. It also
catches secret files force-added with `git add -f`. It lives in `.githooks/` so
it is versioned and shared, but git does not enable hooks automatically:
**every clone must run this once.**

```bash
git config core.hooksPath .githooks
```

It allows obvious placeholders (`dev-only-…`, `REPLACE_WITH_…`, `your-…`) so the
`.example` files still commit cleanly. Genuine false positive? `git commit --no-verify`.

**3. GitHub push protection.** In the repo: *Settings → Code security → Secret
scanning → Push protection*. Free on public repos, and it blocks a known-format
credential at push time even if the local hook was bypassed.

### If a secret does get committed

Deleting the file in a later commit **does not help** — the value is still in the
history, and if it was ever pushed, assume it was scraped within minutes.

**Rotate first, clean up second:**

```bash
npx wrangler secret put SESSION_SECRET   # new value; invalidates all sessions
npx wrangler secret put ADMIN_TOKEN
```

Rotating `SESSION_SECRET` signs everyone out, which is exactly what you want if a
session-signing key leaked. Only after rotating is it worth rewriting history
(`git filter-repo`) — and that is optional, since the rotated value is now
worthless to anyone holding it.

---

## Design decisions and traps

Things that cost real debugging time, or that look wrong until you know why.
Read this before changing the areas it touches.

### Our player IDs *are* Sleeper's player IDs

`players.id` is Sleeper's `player_id` verbatim (numeric strings for people,
team abbreviations like `DEN` for defences). This is what makes the Sleeper
import a direct lookup with no name matching — normally the hardest part of
such an import. Don't renumber them.

### ESPN blocks one hostname and not the other

The schedule notes above say ESPN 403s from workerd. That is true of
`site.api.espn.com` — but **`site.web.api.espn.com` serves the identical payload
and returns 200 from workerd.** Same paths, same JSON, same query parameters.

That is the only reason the news feed can run inside the Worker at all. If news
ingest suddenly starts failing, check the hostname in `worker/services/news.js`
before assuming ESPN changed their API.

It probably also means the schedule could be fetched live rather than from a
generated file. That has not been changed, because the lock state machine
depends on those kickoff times and a working system is worth more than a tidier
one — but it is the first thing to try if the schedule file becomes a nuisance.

### Sleeper's `espn_id` is dead — news is matched by name

Sleeper's player dump has an `espn_id` field, which looks like the obvious way
to tie an ESPN article to one of our players. It is a trap: Sleeper stopped
populating it around 2023. Mahomes and Jefferson have one; Bijan Robinson, Puka
Nacua, Brock Bowers and Jaxson Dart are all `null`. Only ~27% of the top 300
carry one, and the missing ones are exactly the young stars news is written
about.

So ESPN athletes are matched to our players by normalised name — accents,
punctuation and Jr/Sr/III stripped. Measured against a real feed, that resolved
**every fantasy-relevant athlete ESPN tagged**; the only misses were linemen,
defensive backs and punters, who are not in our pool by design.

Two consequences worth knowing:

- Results are cached in `news_player_xref`, including *negative* results, so we
  do not re-attempt the same forty defenders on every refresh.
- That negative cache is cleared after each daily player sync. Without it, a
  miss would be permanent — and the misses that matter fix themselves. Keenan
  Allen was unmatched on the day ESPN reported he had signed with the Colts,
  because a free agent isn't in our dictionary until he is on a roster. Same
  story for every rookie.

### News accumulates; ESPN only shows you 50

Every ESPN news feed returns at most the 50 most recent articles, whatever
`limit` says. So ingest merges into `news_articles` rather than replacing it,
and the archive is ours.

The tick pulls the league feed plus one club's feed, rotating through all 32, so
the archive deepens by a full lap roughly every eight hours. Without the team
rotation, a quiet player's news would be pushed out by a busy news day and
per-player history would barely exist.

News ingest is deliberately the **last** thing the tick does and is wrapped in
its own try/catch. It is the only job depending on a third party nothing else
needs, and nothing in the league hinges on it, so a bad day at ESPN must never
stop waivers from processing.

"Load more" pages backwards with a `before` cursor. The 60-second poll only ever
asks for the newest page and **merges by id**, so paging back doesn't undo
itself once a minute. Each request also records which filter it was issued for
and discards itself if the filter changed while it was in flight — otherwise a
poll for the previous scope lands and shows articles that don't belong to it.

### Known limits of the news feed

Worth knowing before someone asks why a story is missing:

- **History starts when ingest started.** ESPN serves only the newest 50 per
  feed, so the archive can't be backfilled — it only deepens going forward, to
  a 60-day ceiling.
- **One source.** ESPN only. No PFT, no Rotoworld, no beat writers.
- **The tags are ESPN's, not ours.** If ESPN doesn't tag a player, that article
  won't appear under their filter even when the name is in the text. And their
  fantasy roundups tag 50+ players, so "My team" surfaces some generic content.
- **Fantasy positions only.** Linemen, defenders and punters never resolve. News
  about your D/ST's best pass rusher reaches you only via the club tag.
- **D/ST news is club-wide** — all Colts news, not Colts-defense news.
- **Search is a literal `LIKE`** over headline and summary, with no stemming or
  fuzzy matching, and it only searches what's already stored.
- **New signings and rookies can lag a day**, until the daily player sync adds
  them and the crosswalk retries.
- **Up to 15 minutes behind**, on top of ESPN's own publishing delay.

### Standings must exclude playoff weeks

`recalculateStandings` filters to `week <= regularSeasonWeeks`. Without it,
playoff results inflate regular-season records — and because seeds derive from
standings, the bracket's own results would re-order the seeds that created it.

### D1 batches are capped at 100 statements

`batch()` chunks anything larger. Unbounded batches take the Worker down — the
pool reset queues ~950 statements. Chunks are **not** one transaction, so
anything order-sensitive must be submitted as separate, correctly ordered calls.

### The Sleeper import must clear before it inserts

`roster_players` is unique on `(league_id, player_id)`. Clearing and inserting
team-by-team means one team's insert can collide with a player still on another
team whose delete hasn't run. All clears go first, then all inserts, then the
pool is recomputed — in that order, as separate batches.

### A just-drafted league has FREE AGENTS, not waivers

Both the seed and the importer leave `player_pool_state` empty. Putting undrafted
players on waivers made a fresh league look broken: the phase read "open" while
every player was claim-only. The pool moves to waivers on its own at the first
Sunday lock.

### Vue unwraps refs in templates

`toggle(give, id)` hands the function a plain array, not the ref — so `.value`
is `undefined` and the handler throws silently on every click. Pass the side by
name (`toggle('give', id)`) and resolve the ref inside. This broke trades
entirely and was invisible without the console.

### `grid-template-columns: 1fr` is not `minmax(0, 1fr)`

A bare `1fr` keeps an automatic minimum, which resolves to min-content. A wide
child — a `<select>`, whose intrinsic width comes from its longest option —
stretches the track past the viewport. On a phone that makes the browser zoom
out and leaves the sticky header short of the screen edge. Form controls also
carry `min-width: 0` globally for the same reason.

### Live polling pauses when the tab is hidden

[`useLive`](src/composables/useLive.js) skips while `document.visibilityState`
is hidden and catches up on return. It also refuses to refresh over unsaved
lineup edits, an in-flight IR move, an open dialog or a half-built trade offer —
a poll landing mid-edit would silently discard the manager's work.

### IR needs the swap endpoint

A full roster plus a full IR is otherwise a deadlock: activating needs a free
spot, and the only way to make one is to drop somebody. `/ir/swap` does both
moves at once so the count nets out.

## Open questions

Things worth deciding as the league firms up:

1. **Sunday-night reset vs. Monday night football.** The week currently resets
   Sunday 20:00, while SNF and MNF are still being played. The in-progress-game
   rule stops anyone dropping a player mid-game, but you could still drop a
   Monday-night player Monday morning. Moving `WEEK_RESET` to Tuesday 02:00 would
   close that entirely — at the cost of a shorter waiver claim window.
2. **Kickers.** Included by default. Delete the `K` line from `rosterSlots` in
   `worker/config.js` to drop them; nothing else needs changing.
3. **Playoffs.** `playoff_week` is stored but no bracket logic exists yet — the
   season is a 14-week round robin.
4. **IR slots.** The schema supports `on_ir`, but there's no UI for moving players
   to and from IR yet.
