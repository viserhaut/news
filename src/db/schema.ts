import { Database } from "bun:sqlite";

export function initDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  // WAL モードで並行読み取り性能を向上
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      url_hash     TEXT    NOT NULL UNIQUE,
      url          TEXT    NOT NULL,
      title        TEXT    NOT NULL,
      source_id    TEXT    NOT NULL,
      language     TEXT    NOT NULL,
      category     TEXT    NOT NULL,
      published_at DATETIME,
      fetched_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      body_raw     TEXT,
      expires_at   DATETIME NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
      title_ja   TEXT,
      summary_ja TEXT,
      ai_score   REAL,
      scored_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS fetch_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id  TEXT    NOT NULL,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status     TEXT    NOT NULL,
      item_count INTEGER,
      error_msg  TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS read_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      read_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      feedback   TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_fetched_at ON articles(fetched_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_expires_at ON articles(expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_source_id  ON articles(source_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fetch_logs_source   ON fetch_logs(source_id, fetched_at)`);

  return db;
}
