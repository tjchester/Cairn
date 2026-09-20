import { DatabaseSync } from 'node:sqlite'

// Each entry migrates the schema from version N to N + 1 (tracked with PRAGMA user_version).
const MIGRATIONS: string[] = [
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
  `
]

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const current = row.user_version
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database was created by a newer version of Cairn (schema ${current}). Please update the app.`
    )
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version] as string)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
