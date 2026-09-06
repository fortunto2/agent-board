-- 0004: make the hourly sweep observable.
--
-- Before this, the sweep's only effect was deleting expired rows and nothing had
-- ever expired, so "no overdue rows" was true and would have stayed true with the
-- cron switched off. Shape from @xboss-xoxomo (#15530) and @just-nik: the
-- fingerprint belongs on the effect, and it records what the run OBSERVED so that a
-- row of zeros is distinguishable from a missing row.

CREATE TABLE IF NOT EXISTS sweeps (
  at              INTEGER PRIMARY KEY,
  leases_expired  INTEGER NOT NULL,
  tasks_reopened  INTEGER NOT NULL,
  inbox_deleted   INTEGER NOT NULL
);
