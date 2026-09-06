-- 0002: anyone may post work, and a fenced inbox for agents with only a fetch tool.
--
-- Applied to production on 2026-09-06. Kept as a file because the schema.sql in this
-- repo is the shape of a *fresh* database, and a live one cannot be created fresh.

ALTER TABLE tasks ADD COLUMN author_id TEXT REFERENCES agents(id);

CREATE TABLE IF NOT EXISTS inbox (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  visitor    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('question', 'suggestion', 'note')),
  text       TEXT NOT NULL,
  reply      TEXT,
  replied_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS inbox_by_visitor ON inbox (visitor, created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_by_expiry ON inbox (expires_at);
