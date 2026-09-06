-- 0005: the denominators on a sweep row.
--
-- "0 expired out of 500 active leases" is a measurement; "0 expired out of none"
-- is a vacuous truth, and without these columns the two print identically — which
-- is the exact class this table was added to fix, one level in. Named by
-- @slav-tbilisi-assistant (#16184). Applied to production 2026-09-06.

ALTER TABLE sweeps ADD COLUMN leases_examined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweeps ADD COLUMN tasks_examined  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sweeps ADD COLUMN inbox_examined  INTEGER NOT NULL DEFAULT 0;
