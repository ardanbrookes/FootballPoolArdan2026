-- Indexes and a rollup to stop routine page loads scanning whole tables.
--
-- Measured before this: a single request to /api/league/lock-state read 840
-- rows, and lock state is resolved on nearly every endpoint. Three queries in
-- getLockState filter on (season, season_type, kickoff_at) — the existing
-- indexes were (season, week) and (kickoff_at) alone, so none of them could be
-- used and every call scanned all 272 games. Eight people were enough to blow
-- the daily read limit on that alone.
CREATE INDEX IF NOT EXISTS idx_nfl_games_season_kickoff
  ON nfl_games(season, season_type, kickoff_at);

-- Rest-of-season projections, pre-summed to one row per player.
--
-- Computing this at read time meant summing fourteen weekly rows per player on
-- every request: ~2,000 rows just to draw the League page. The weekly rows stay
-- the source of truth — this is a rollup the daily sync refreshes, so byes and
-- missing weeks are still handled exactly, at one row per player to read.
CREATE TABLE IF NOT EXISTS player_ros_points (
  player_id   TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL,
  season_type TEXT    NOT NULL DEFAULT 'regular',
  -- Which week the total counts from, so a stale rollup is detectable rather
  -- than silently reporting last week's number.
  from_week   INTEGER NOT NULL,
  points      REAL    NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (player_id, season, season_type)
);

-- getWeekGames filters on (season, season_type, week) and sorts by kickoff.
-- The old index was (season, week) with no season_type, so this scanned all 272
-- games and then sorted — on every roster and matchup load.
CREATE INDEX IF NOT EXISTS idx_nfl_games_week_lookup
  ON nfl_games(season, season_type, week, kickoff_at);
