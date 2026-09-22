-- Monday-night recaps.
--
-- Stored rather than computed on demand, for two reasons. Half of a recap
-- depends on the rosters as they were that week — optimal lineups, benched
-- points — and teams reopen for business the moment the week resets, so the
-- same question asked on Thursday gives a different answer. And reading last
-- week's recap should never re-run a playoff simulation.
CREATE TABLE IF NOT EXISTS week_recaps (
  league_id    INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  payload_json TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (league_id, season, week)
);
