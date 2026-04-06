import type { Database } from "bun:sqlite";

export interface ArticleRow {
  id: number;
  url_hash: string;
  url: string;
  title: string;
  source_id: string;
  language: string;
  category: string;
  published_at: string | null;
  fetched_at: string;
  body_raw: string | null;
  expires_at: string;
}

export interface ArticleInsert {
  $url_hash: string;
  $url: string;
  $title: string;
  $source_id: string;
  $language: string;
  $category: string;
  $published_at: string | null;
  $body_raw: string | null;
}

export interface FetchLogInsert {
  $source_id: string;
  $status: "ok" | "error";
  $item_count: number | null;
  $error_msg: string | null;
}

export function makeQueries(db: Database) {
  // TTL: 365日後
  const insertArticle = db.prepare<void, ArticleInsert>(`
    INSERT OR IGNORE INTO articles
      (url_hash, url, title, source_id, language, category, published_at, body_raw, expires_at)
    VALUES
      ($url_hash, $url, $title, $source_id, $language, $category, $published_at, $body_raw,
       datetime('now', '+365 days'))
  `);

  const insertFetchLog = db.prepare<void, FetchLogInsert>(`
    INSERT INTO fetch_logs (source_id, status, item_count, error_msg)
    VALUES ($source_id, $status, $item_count, $error_msg)
  `);

  const countArticlesBySource = db.prepare<{ count: number }, { $source_id: string }>(`
    SELECT COUNT(*) as count FROM articles WHERE source_id = $source_id
  `);

  const deleteExpired = db.prepare<void, []>(`
    DELETE FROM articles WHERE expires_at < datetime('now')
  `);

  return {
    insertArticle,
    insertFetchLog,
    countArticlesBySource,
    deleteExpired,
  };
}
