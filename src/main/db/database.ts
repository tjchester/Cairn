import { copyFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { urlKey } from '@shared/url'
import { EARLIEST_BOOKMARK_DATE } from '../services/importTree'

// Each entry migrates the schema from version N to N + 1 (tracked with PRAGMA user_version): SQL, or a function
// for the steps that need to look at the data.
export type Migration = string | ((db: DatabaseSync) => void)

export const MIGRATIONS: Migration[] = [
  /* v1 */ `
  CREATE TABLE collections (
    id          INTEGER PRIMARY KEY,
    parent_id   INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_collections_parent ON collections(parent_id);

  CREATE TABLE bookmarks (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    url             TEXT NOT NULL,
    url_key         TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    excerpt         TEXT NOT NULL DEFAULT '',
    cover_url       TEXT,
    favicon_url     TEXT,
    domain          TEXT NOT NULL DEFAULT '',
    favorite        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'unknown',
    http_status     INTEGER,
    last_checked_at TEXT,
    search_text     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
  );
  CREATE INDEX idx_bookmarks_collection ON bookmarks(collection_id);
  CREATE INDEX idx_bookmarks_url_key    ON bookmarks(url_key);
  CREATE INDEX idx_bookmarks_deleted    ON bookmarks(deleted_at);
  CREATE INDEX idx_bookmarks_created    ON bookmarks(created_at);

  CREATE TABLE tags (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE bookmark_tags (
    bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
  );
  CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags(tag_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* v2: auto-tagging */ `
  -- What each page said about itself (keywords, type, language, first paragraphs), as JSON.
  -- NULL means "never successfully fetched"; an empty object means "fetched, nothing to learn".
  ALTER TABLE bookmarks ADD COLUMN signals TEXT;

  -- Where a tag came from: 'user', or 'builtin' / 'llm' for automatic ones, and which run added it.
  ALTER TABLE bookmark_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
  ALTER TABLE bookmark_tags ADD COLUMN run_id INTEGER;
  CREATE INDEX idx_bookmark_tags_run ON bookmark_tags(run_id);

  CREATE TABLE tag_runs (
    id                INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL,
    mode              TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    tags_applied      INTEGER NOT NULL DEFAULT 0,
    bookmarks_touched INTEGER NOT NULL DEFAULT 0,
    undone            INTEGER NOT NULL DEFAULT 0
  );

  -- Suggested tags waiting for review. Rejected rows are kept so a later run does not propose them again.
  CREATE TABLE tag_proposals (
    id          INTEGER PRIMARY KEY,
    run_id      INTEGER REFERENCES tag_runs(id) ON DELETE SET NULL,
    bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL COLLATE NOCASE,
    score       REAL NOT NULL,
    origin      TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    UNIQUE (bookmark_id, tag)
  );
  CREATE INDEX idx_tag_proposals_tag ON tag_proposals(tag);

  -- Tags the user never wants suggested.
  CREATE TABLE tag_blocklist (
    tag TEXT PRIMARY KEY COLLATE NOCASE
  );
  `,
  /* v3 */ `
  -- Bookmarks the local model has already classified, so a long run can be stopped and continued (or repeated
  -- later) without asking the model about the same bookmark twice. "model" is empty for rows recovered below.
  CREATE TABLE llm_seen (
    bookmark_id INTEGER PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    model       TEXT NOT NULL DEFAULT '',
    at          TEXT NOT NULL
  );

  -- Recover what earlier runs already did. A run that used the model has model-made tags (or suggestions) in it, and
  -- every tag or suggestion the run made for other bookmarks came from the same pass over the model.
  INSERT OR IGNORE INTO llm_seen (bookmark_id, model, at)
  SELECT bt.bookmark_id, '', MIN(r.created_at)
    FROM bookmark_tags bt JOIN tag_runs r ON r.id = bt.run_id
   WHERE bt.source <> 'user' AND r.kind IN ('auto-tag', 'capture')
     AND bt.run_id IN (SELECT run_id FROM bookmark_tags WHERE source = 'llm' AND run_id IS NOT NULL)
   GROUP BY bt.bookmark_id;

  INSERT OR IGNORE INTO llm_seen (bookmark_id, model, at)
  SELECT p.bookmark_id, '', MIN(r.created_at)
    FROM tag_proposals p JOIN tag_runs r ON r.id = p.run_id
   WHERE r.kind IN ('auto-tag', 'capture')
     AND p.run_id IN (SELECT run_id FROM tag_proposals WHERE origin = 'llm' AND run_id IS NOT NULL)
   GROUP BY p.bookmark_id;
  `,
  /* v4 */ `
  -- What "Tidy tags" changed, in enough detail to put it back (only the latest few are kept).
  CREATE TABLE tidy_log (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    merged     INTEGER NOT NULL DEFAULT 0,
    removed    INTEGER NOT NULL DEFAULT 0,
    payload    TEXT NOT NULL,
    undone     INTEGER NOT NULL DEFAULT 0
  );
  `,
  /* v5 */ `
  -- Which kind of tidy an entry can put back: 'tags' (merged and removed tags) or 'collections' (empty ones).
  ALTER TABLE tidy_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'tags';
  `,
  /* v6 */ recomputeUrlKeys,
  /* v7 */ `
  -- Marks the one collection that is the Archive ('archive'); every other collection has no role. What is kept there
  -- is left out of the ordinary lists, searches and jobs unless archived items are asked for.
  ALTER TABLE collections ADD COLUMN role TEXT;
  CREATE UNIQUE INDEX idx_collections_role ON collections(role) WHERE role IS NOT NULL;
  `,
  /* v8 */ (db) => {
    // The key of the address a link redirects to, when it is a new home for the page (see redirectKey): it lets the
    // duplicate finder see a bookmark for a page that moved next to one saved at the new address.
    db.exec('ALTER TABLE bookmarks ADD COLUMN final_url_key TEXT')
    db.exec('CREATE INDEX idx_bookmarks_final_url_key ON bookmarks(final_url_key) WHERE final_url_key IS NOT NULL')
    repairEpochDates(db)
    recomputeUrlKeys(db) // the rules gained index pages, repeated slashes, GitHub names and more tracking markers
  }
]

/**
 * Imports used to read a missing date (written as 0) as 1 January 1970. Such bookmarks sorted as the oldest, so the
 * duplicate finder kept them over the real ones. The date they were last changed is the nearest thing to when they
 * arrived.
 */
function repairEpochDates(db: DatabaseSync): void {
  const cutoff = new Date(EARLIEST_BOOKMARK_DATE).toISOString()
  db.prepare(
    `UPDATE bookmarks SET created_at = CASE WHEN updated_at >= ? THEN updated_at ELSE ? END WHERE created_at < ?`
  ).run(cutoff, new Date().toISOString(), cutoff)
}

/**
 * The key that decides whether two bookmarks are the same page is worked out when a bookmark is saved, so the rows
 * already in the library still carry the older rules (which kept `?ref=…` and other "where you came from" markers
 * apart). Working them out again lets the duplicate finder see those pairs.
 */
function recomputeUrlKeys(db: DatabaseSync): void {
  const update = db.prepare('UPDATE bookmarks SET url_key = ? WHERE id = ?')
  for (const row of db.prepare('SELECT id, url, url_key FROM bookmarks').all() as { id: number; url: string; url_key: string }[]) {
    const key = urlKey(String(row.url))
    if (key !== row.url_key) update.run(key, Number(row.id))
  }
}

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
  migrate(db, file)
  return db
}

function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const current = row.user_version
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database was created by a newer version of Cairn (schema ${current}). Please update the app.`
    )
  }
  // Upgrading a database that already holds data: keep a copy of it as it was, once per schema version.
  if (current > 0 && current < MIGRATIONS.length && file !== ':memory:') {
    const backup = file + '.v' + current + '.bak'
    if (!existsSync(backup)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      copyFileSync(file, backup)
    }
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      const step = MIGRATIONS[version] as Migration
      if (typeof step === 'string') db.exec(step)
      else step(db)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
