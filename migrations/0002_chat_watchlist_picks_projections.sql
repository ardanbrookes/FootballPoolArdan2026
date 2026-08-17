-- League chat, watchlists, draft picks in trades, and cached projections.
--
-- Forward-only: 0001 is already applied everywhere, so changes go in new files.

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
-- Holds both people talking and the league's own event log. Keeping system
-- events in the same table as chat means one query, one feed, one sort order —
-- rather than merging two streams and fighting over pagination.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  -- NULL for system posts; the app renders those differently.
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id    INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  kind       TEXT    NOT NULL DEFAULT 'chat',   -- chat | system
  -- For system posts: phase | trade | add | drop | waiver | ir. NULL for chat.
  event_type TEXT,
  body       TEXT    NOT NULL,
  -- Optional structured payload (player ids, team ids) for richer rendering.
  meta_json  TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_league_time ON messages(league_id, created_at DESC);
CREATE INDEX idx_messages_kind ON messages(league_id, kind);

-- ---------------------------------------------------------------------------
-- Watchlist
-- ---------------------------------------------------------------------------
-- Per-user, not per-team: it's a personal shortlist, and it should survive if a
-- manager ever changes teams.
CREATE TABLE watchlist (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id  TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (league_id, user_id, player_id)
);
CREATE INDEX idx_watchlist_user ON watchlist(league_id, user_id);

-- ---------------------------------------------------------------------------
-- Draft picks in trades
-- ---------------------------------------------------------------------------
-- Record-keeping only. The app never drafts, so a traded pick has no mechanical
-- effect — it exists so next year's draft order can be adjusted by hand with an
-- authoritative record of who agreed to what.
CREATE TABLE trade_picks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id     INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  -- The team giving the pick up in this trade.
  from_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- Whose pick it originally is — usually the same team, but a pick acquired in
  -- an earlier trade can be flipped on.
  original_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  season       INTEGER NOT NULL,
  round        INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_trade_picks_trade ON trade_picks(trade_id);

-- ---------------------------------------------------------------------------
-- Projections
-- ---------------------------------------------------------------------------
-- Same shape as player_stats, and Sleeper uses the same stat keys for both, so
-- the league's own scoring config turns a projection into projected points with
-- no extra mapping.
CREATE TABLE player_projections (
  player_id   TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL,
  season_type TEXT    NOT NULL DEFAULT 'regular',
  week        INTEGER NOT NULL,
  stats_json  TEXT    NOT NULL DEFAULT '{}',
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (player_id, season, season_type, week)
);
CREATE INDEX idx_projections_week ON player_projections(season, week);
