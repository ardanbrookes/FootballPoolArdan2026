-- Initial schema.
--
-- Portability note: this file is plain SQLite DDL with no better-sqlite3-specific
-- syntax, so it applies cleanly to Cloudflare D1 / Turso as well as a local file.
-- All timestamps are ISO-8601 UTC strings ('2026-09-08T07:00:00.000Z') so they
-- sort lexicographically and survive any driver without a native date type.

CREATE TABLE leagues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  season        INTEGER NOT NULL,
  season_type   TEXT    NOT NULL DEFAULT 'regular',
  current_week  INTEGER NOT NULL DEFAULT 1,
  playoff_week  INTEGER NOT NULL DEFAULT 15,
  rules_url     TEXT,
  draft_url     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  email           TEXT,
  password_hash   TEXT    NOT NULL,
  password_salt   TEXT    NOT NULL,
  is_commissioner INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE teams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT    NOT NULL,
  abbreviation TEXT    NOT NULL,
  logo_url     TEXT,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  ties         INTEGER NOT NULL DEFAULT 0,
  points_for   REAL    NOT NULL DEFAULT 0,
  points_against REAL  NOT NULL DEFAULT 0,
  -- TSLC waiver priority: the timestamp of this team's last SUCCESSFUL claim.
  -- NULL means "never claimed", which sorts to the front of the queue.
  last_waiver_claim_at TEXT,
  -- Stable random-ish tiebreaker of last resort (draft order).
  waiver_order_seed INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (league_id, abbreviation)
);
CREATE INDEX idx_teams_league ON teams(league_id);
CREATE INDEX idx_teams_user ON teams(user_id);

-- Mirror of the Sleeper player dump. `id` is Sleeper's player_id, which is a
-- numeric string for people and a team abbreviation for defenses (e.g. 'DEN').
CREATE TABLE players (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  position      TEXT,
  fantasy_positions TEXT,      -- JSON array, e.g. '["RB","WR"]'
  nfl_team      TEXT,          -- abbreviation, NULL for free agents in real life
  jersey_number INTEGER,
  status        TEXT,          -- Active / Inactive / Injured Reserve ...
  injury_status TEXT,          -- Questionable / Out / IR ...
  bye_week      INTEGER,
  years_exp     INTEGER,
  search_rank   INTEGER,       -- Sleeper's rough popularity rank; lower = more relevant
  age           INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_players_position ON players(position);
CREATE INDEX idx_players_nfl_team ON players(nfl_team);
CREATE INDEX idx_players_search_rank ON players(search_rank);
CREATE INDEX idx_players_name ON players(full_name);

CREATE TABLE nfl_games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  season      INTEGER NOT NULL,
  season_type TEXT    NOT NULL DEFAULT 'regular',
  week        INTEGER NOT NULL,
  home_team   TEXT    NOT NULL,
  away_team   TEXT    NOT NULL,
  kickoff_at  TEXT    NOT NULL,   -- ISO-8601 UTC
  status      TEXT    NOT NULL DEFAULT 'scheduled',
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (season, season_type, week, home_team, away_team)
);
CREATE INDEX idx_nfl_games_week ON nfl_games(season, week);
CREATE INDEX idx_nfl_games_kickoff ON nfl_games(kickoff_at);

-- Who owns whom, right now. One row per rostered player.
CREATE TABLE roster_players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id    TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  acquired_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acquired_via TEXT    NOT NULL DEFAULT 'draft', -- draft | waiver | free_agent | trade
  on_ir        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (league_id, player_id)
);
CREATE INDEX idx_roster_team ON roster_players(team_id);

-- Weekly starting lineup. A slot with player_id NULL is an empty starter slot.
-- Anything rostered but not listed here for the week is on the bench and scores 0.
CREATE TABLE lineups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season    INTEGER NOT NULL,
  week      INTEGER NOT NULL,
  slot      TEXT    NOT NULL,   -- matches rosterSlots[].slot in config/league.js
  player_id TEXT    REFERENCES players(id) ON DELETE SET NULL,
  UNIQUE (league_id, team_id, season, week, slot)
);
CREATE INDEX idx_lineups_lookup ON lineups(league_id, team_id, season, week);

-- Availability of unrostered players. Absence of a row means free agent.
CREATE TABLE player_pool_state (
  league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id        TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- While now() < waivers_clear_at the player is ON WAIVERS (claim only).
  -- Once passed, they are a FREE AGENT (first come, first served).
  waivers_clear_at TEXT,
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (league_id, player_id)
);

CREATE TABLE waiver_claims (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id      INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  add_player_id  TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  drop_player_id TEXT    REFERENCES players(id) ON DELETE SET NULL,
  -- Team-scoped ordering: 1 is this manager's most-wanted claim.
  priority       INTEGER NOT NULL DEFAULT 1,
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending|success|failed|cancelled
  result_reason  TEXT,
  processed_at   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_claims_pending ON waiver_claims(league_id, status, season, week);
CREATE INDEX idx_claims_team ON waiver_claims(team_id, status);

CREATE TABLE transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id           INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  type              TEXT    NOT NULL,  -- add | drop | trade | lineup
  source            TEXT,              -- free_agent | waiver | trade | draft
  player_id         TEXT REFERENCES players(id) ON DELETE SET NULL,
  related_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  related_team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  season            INTEGER NOT NULL,
  week              INTEGER NOT NULL,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tx_league_time ON transactions(league_id, created_at);
CREATE INDEX idx_tx_team ON transactions(team_id);

CREATE TABLE trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  proposer_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  receiver_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|cancelled
  message          TEXT,
  response_message TEXT,
  season           INTEGER NOT NULL,
  week             INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT
);
CREATE INDEX idx_trades_league ON trades(league_id, status);

CREATE TABLE trade_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id     INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  from_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id    TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE
);
CREATE INDEX idx_trade_items_trade ON trade_items(trade_id);

CREATE TABLE matchups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_score   REAL    NOT NULL DEFAULT 0,
  away_score   REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|final
  UNIQUE (league_id, season, week, home_team_id)
);
CREATE INDEX idx_matchups_week ON matchups(league_id, season, week);

-- Raw weekly stat lines from Sleeper. Points are computed at read time using
-- the league's scoring config, so changing scoring never needs a backfill.
CREATE TABLE player_stats (
  player_id  TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL,
  season_type TEXT   NOT NULL DEFAULT 'regular',
  week       INTEGER NOT NULL,
  stats_json TEXT    NOT NULL DEFAULT '{}',
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (player_id, season, season_type, week)
);
CREATE INDEX idx_stats_week ON player_stats(season, week);

-- Runtime overrides for anything in config/league.js `timing`.
CREATE TABLE league_settings (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value_json TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (league_id, key)
);

-- Bookkeeping for external syncs so we don't refetch the 5MB player dump.
CREATE TABLE sync_log (
  key          TEXT PRIMARY KEY,
  last_run_at  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok',
  detail       TEXT
);
