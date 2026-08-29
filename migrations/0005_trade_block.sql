-- Trade block: players their manager is openly willing to move.
--
-- A flag on the roster row rather than a table of its own — it is one boolean
-- per rostered player, it dies with the roster row when they are dropped or
-- traded, and "is this player available" becomes a column read rather than a
-- join on every trade screen.
ALTER TABLE roster_players ADD COLUMN on_trade_block INTEGER NOT NULL DEFAULT 0;

-- When they were listed, so the trade block can show newest first.
ALTER TABLE roster_players ADD COLUMN trade_block_at TEXT;
