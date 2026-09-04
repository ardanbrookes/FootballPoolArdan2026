-- Commissioner tools.
--
-- A commissioner-set score has to survive the next stats refresh. Without this
-- flag `recalculateMatchups` would recompute both sides from the stat lines on
-- the very next tick and silently discard the correction, which is the one
-- outcome that makes a manual override worthless.
ALTER TABLE matchups ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0;
