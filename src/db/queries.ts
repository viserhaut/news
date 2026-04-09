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
  [key: string]: string | number | bigint | boolean | Uint8Array | null;
  $url_hash: string;
  $url: string;
  $title: string;
  $source_id: string;
  $language: "ja" | "en";
  $category: string;
  $published_at: string | null;
  $body_raw: string | null;
}

export interface FetchLogInsert {
  [key: string]: string | number | bigint | boolean | Uint8Array | null;
  $source_id: string;
  $status: "ok" | "error";
  $item_count: number | null;
  $error_msg: string | null;
}

export interface SummaryInsert {
  [key: string]: string | number | bigint | boolean | Uint8Array | null;
  $article_id: number;
  $title_ja: string;
  $summary_ja: string;
  $ai_score: number;
  $detail_summary_ja: string | null;
}

export interface UnsummarizedRow {
  id: number;
  url: string;
  title: string;
  source_id: string;
  language: string;
  category: string;
  published_at: string | null;
  body_raw: string | null;
}

export interface CategoryReadRow {
  category: string;
  cnt: number;
  decayed_count: number;
}

export interface RecentReadRow {
  title: string;
  title_ja: string | null;
  summary_ja: string | null;
  category: string;
  source_id: string;
  feedback: string | null;
}

export interface UserPreference {
  type: string;
  value: string;
}

export interface DigestArticleRow {
  id: number;
  url: string;
  title_ja: string | null;
  summary_ja: string | null;
  detail_summary_ja: string | null;
  category: string;
  source_id: string;
  published_at: string | null;
  og_image: string | null;
  personal_score: number | null;
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

  const updateBodyRaw = db.prepare<void, { $id: number; $body_raw: string | null }>(`
    UPDATE articles SET body_raw = $body_raw WHERE id = $id
  `);

  const selectArticlesWithoutBody = db.prepare<ArticleRow, []>(`
    SELECT * FROM articles WHERE body_raw IS NULL ORDER BY fetched_at DESC
  `);

  const selectUnsummarized = db.prepare<UnsummarizedRow, []>(`
    SELECT a.id, a.url, a.title, a.source_id, a.language,
           a.category, a.published_at, a.body_raw
    FROM articles a
    LEFT JOIN summaries s ON s.article_id = a.id
    WHERE s.article_id IS NULL
    ORDER BY a.fetched_at DESC
  `);

  const insertSummary = db.prepare<void, SummaryInsert>(`
    INSERT OR REPLACE INTO summaries (article_id, title_ja, summary_ja, ai_score, detail_summary_ja)
    VALUES ($article_id, $title_ja, $summary_ja, $ai_score, $detail_summary_ja)
  `);

  // ── 読了履歴 ──────────────────────────────────────────
  const insertReadHistory = db.prepare<void, { $article_id: number; $feedback: string | null }>(`
    INSERT INTO read_history (article_id, feedback) VALUES ($article_id, $feedback)
  `);

  const updateReadFeedback = db.prepare<void, { $article_id: number; $feedback: string }>(`
    UPDATE read_history SET feedback = $feedback
    WHERE id = (SELECT MAX(id) FROM read_history WHERE article_id = $article_id)
  `);

  // Layer1 用: 30日以内のカテゴリ別読了集計（指数減衰）
  const selectReadCountByCategory = db.prepare<CategoryReadRow, []>(`
    SELECT a.category,
           COUNT(*) as cnt,
           SUM(exp(-0.3 * (julianday('now') - julianday(r.read_at)))) as decayed_count
    FROM read_history r
    JOIN articles a ON a.id = r.article_id
    WHERE r.read_at > datetime('now', '-30 days')
    GROUP BY a.category
  `);

  // Layer2 用: 最近100件の読了記事
  const selectRecentReads = db.prepare<RecentReadRow, []>(`
    SELECT a.title, s.title_ja, s.summary_ja, a.category, a.source_id, r.feedback
    FROM read_history r
    JOIN articles a ON a.id = r.article_id
    LEFT JOIN summaries s ON s.article_id = a.id
    ORDER BY r.read_at DESC
    LIMIT 100
  `);

  // ── セマンティックプロファイル ───────────────────────
  const insertSemanticProfile = db.prepare<void, { $profile: string; $based_on: number }>(`
    INSERT INTO semantic_profile (profile, based_on) VALUES ($profile, $based_on)
  `);

  const selectLatestProfile = db.prepare<{ profile: string; based_on: number }, []>(`
    SELECT profile, based_on FROM semantic_profile ORDER BY id DESC LIMIT 1
  `);

  // ── ユーザー設定 ──────────────────────────────────────
  const selectUserPreferences = db.prepare<UserPreference, []>(`
    SELECT type, value FROM user_preferences ORDER BY type, value
  `);

  const insertUserPreference = db.prepare<void, { $type: string; $value: string }>(`
    INSERT OR IGNORE INTO user_preferences (type, value) VALUES ($type, $value)
  `);

  const deleteUserPreference = db.prepare<void, { $type: string; $value: string }>(`
    DELETE FROM user_preferences WHERE type = $type AND value = $value
  `);

  // ── personal_score 更新 ───────────────────────────────
  const updatePersonalScore = db.prepare<void, { $article_id: number; $personal_score: number }>(`
    UPDATE summaries SET personal_score = $personal_score WHERE article_id = $article_id
  `);

  // personal_score が未設定の summaries を取得（ai_score と category を含む）
  const selectSummariesForBoost = db.prepare<
    { article_id: number; ai_score: number; category: string },
    []
  >(`
    SELECT s.article_id, s.ai_score, a.category
    FROM summaries s
    JOIN articles a ON a.id = s.article_id
  `);

  // 読了件数（プロファイル再生成トリガー判定用）
  const countReadHistory = db.prepare<{ count: number }, []>(`
    SELECT COUNT(*) as count FROM read_history
  `);

  // ── Web UI 向け ────────────────────────────────────────
  const selectDigestArticles = db.prepare<DigestArticleRow, []>(`
    SELECT a.id, a.url, a.category, a.source_id, a.published_at, a.og_image,
           s.title_ja, s.summary_ja, s.detail_summary_ja,
           COALESCE(s.personal_score, s.ai_score) AS personal_score
    FROM articles a
    JOIN summaries s ON s.article_id = a.id
    WHERE a.published_at > datetime('now', '-7 days')
      AND s.title_ja IS NOT NULL
    ORDER BY personal_score DESC
  `);

  const updateOgImage = db.prepare<void, { $id: number; $og_image: string | null }>(`
    UPDATE articles SET og_image = $og_image WHERE id = $id
  `);

  return {
    insertArticle,
    insertFetchLog,
    countArticlesBySource,
    deleteExpired,
    updateBodyRaw,
    selectArticlesWithoutBody,
    selectUnsummarized,
    insertSummary,
    insertReadHistory,
    updateReadFeedback,
    selectReadCountByCategory,
    selectRecentReads,
    insertSemanticProfile,
    selectLatestProfile,
    selectUserPreferences,
    insertUserPreference,
    deleteUserPreference,
    updatePersonalScore,
    selectSummariesForBoost,
    countReadHistory,
    selectDigestArticles,
    updateOgImage,
  };
}
