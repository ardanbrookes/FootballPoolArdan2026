-- NFL news feed, tagged to our players so it can be filtered by roster,
-- watchlist, or a single player.
--
-- Forward-only: 0001 and 0002 are already applied everywhere.

-- ---------------------------------------------------------------------------
-- Articles
-- ---------------------------------------------------------------------------
-- ESPN's news endpoint only ever returns the 50 most recent items, so this
-- table is an accumulating archive: every refresh upserts, and old articles
-- stay until pruned. That is the only way to offer a feed you can scroll back
-- through, and the only way a quiet player's news survives a busy news day.
--
-- Not league-scoped: NFL news is the same for everyone. Filtering by roster or
-- watchlist happens at read time via news_article_players.
CREATE TABLE news_articles (
  -- ESPN's article id, so re-ingesting the same article updates rather than
  -- duplicating. Prefixed with the source to keep room for other feeds later.
  id           TEXT PRIMARY KEY,          -- e.g. 'espn:45231234'
  source       TEXT NOT NULL DEFAULT 'espn',
  headline     TEXT NOT NULL,
  description  TEXT,
  byline       TEXT,
  -- Story | HeadlineNews | Media | Recap ... ESPN's own classification; the UI
  -- uses it to badge video and to let breaking news stand out.
  type         TEXT,
  url          TEXT,
  image_url    TEXT,
  published_at TEXT NOT NULL,
  -- Team abbreviations tagged on the article, JSON array in OUR vocabulary
  -- (ESPN's WSH is rewritten to WAS). Denormalised because it is small, and
  -- because the team filter is a substring test rather than a join.
  teams_json   TEXT NOT NULL DEFAULT '[]',
  fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_news_published ON news_articles(published_at DESC);

-- ---------------------------------------------------------------------------
-- Article -> player tags
-- ---------------------------------------------------------------------------
-- The join that makes "my roster" and "my watchlist" possible. One row per
-- (article, player); an article about a trade tags both players.
CREATE TABLE news_article_players (
  article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, player_id)
);
-- Drives the roster/watchlist filter: given a set of player ids, find articles.
CREATE INDEX idx_news_players_player ON news_article_players(player_id);

-- ---------------------------------------------------------------------------
-- ESPN athlete -> our player crosswalk
-- ---------------------------------------------------------------------------
-- Sleeper publishes an espn_id field but stopped populating it around 2023 —
-- Mahomes has one, Bijan Robinson and Brock Bowers do not. Only ~27% of the
-- top 300 carry it, and the gaps are exactly the young stars news is about.
--
-- So tags are resolved by normalised name instead, and the result is cached
-- here. After the first sighting a player becomes an id lookup, which is both
-- faster and stable if a name renders differently later. player_id NULL is a
-- negative cache: ESPN tags a lot of linemen and defenders we do not carry,
-- and without this we would re-attempt those names on every single refresh.
CREATE TABLE news_player_xref (
  espn_athlete_id TEXT PRIMARY KEY,
  player_id       TEXT REFERENCES players(id) ON DELETE CASCADE,
  display_name    TEXT,
  resolved_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
