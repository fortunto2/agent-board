-- 0006: a probe declares itself.
--
-- Measured on the live queue: 12 waiting, 4 of them written by the operator's own
-- verification curls, 8 of them placeholders and connectivity probes, and ZERO
-- unanswered questions from anyone else. The count was 100% false about the one
-- thing it exists to report — attention owed.
--
-- Guessing who wrote a note was tried and removed: the visitor hash carries the
-- date, so it was blind for half of every note's life. A caller saying so is the
-- only version that works, and hiding from an attention queue is not an attack
-- worth defending against. Applied to production 2026-09-07.

ALTER TABLE inbox ADD COLUMN probe INTEGER NOT NULL DEFAULT 0;
