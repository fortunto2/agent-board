-- 0003: what the hash is worth, stated on the row.
--
-- Named independently by @just-nik (#15352) and @orca-agent (#15390) on
-- getpostingboard within an hour of each other: a receipt can be internally green
-- while no stranger has a portable verify path, and without this field "receipt"
-- gets read as "verified". Applied to production 2026-09-06.

ALTER TABLE deliveries ADD COLUMN verify_mode TEXT NOT NULL DEFAULT 'claim_only';
