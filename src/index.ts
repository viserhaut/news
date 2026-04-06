import { join } from "path";
import { mkdirSync } from "fs";
import { initDb } from "./db/schema";
import { makeQueries } from "./db/queries";
import { loadSources } from "./config/sources";
import { fetchSource } from "./fetch/rss";
import { fetchBody } from "./fetch/body";
import { summarizeBatch } from "./llm/summarize";
import { ClaudeAuthError } from "./llm/claude";

const ROOT_DIR = join(import.meta.dir, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT_DIR, "data", "digest.db");
const BODY_CONCURRENCY = 10;

async function main() {
  mkdirSync(join(ROOT_DIR, "data"), { recursive: true });

  const db = initDb(DB_PATH);
  const q = makeQueries(db);

  q.deleteExpired.run();

  // ── Step 1: RSS フェッチ ──────────────────────────────
  const sources = loadSources(ROOT_DIR);
  console.log(`[info] ${sources.length} sources loaded`);

  const results = await Promise.all(sources.map(fetchSource));

  let totalNew = 0;
  for (const result of results) {
    q.insertFetchLog.run({
      $source_id: result.source_id,
      $status: result.error ? "error" : "ok",
      $item_count: result.error ? null : result.articles.length,
      $error_msg: result.error ?? null,
    });

    if (result.error) {
      console.error(`[error] ${result.source_id}: ${result.error}`);
      continue;
    }

    let newCount = 0;
    for (const article of result.articles) {
      const before =
        (q.countArticlesBySource.get({ $source_id: article.$source_id }) as { count: number })
          ?.count ?? 0;
      q.insertArticle.run(article);
      const after =
        (q.countArticlesBySource.get({ $source_id: article.$source_id }) as { count: number })
          ?.count ?? 0;
      if (after > before) newCount++;
    }

    totalNew += newCount;
    console.log(`[ok]    ${result.source_id}: ${result.articles.length} fetched, ${newCount} new`);
  }

  console.log(`\n[info] Total new articles: ${totalNew}`);

  // ── Step 2: Body fetch ───────────────────────────────
  const noBody = q.selectArticlesWithoutBody.all() as Array<{ id: number; url: string }>;
  console.log(`[info] Fetching bodies for ${noBody.length} articles...`);

  // 最大 BODY_CONCURRENCY 件を並列処理するスライディングウィンドウ
  for (let i = 0; i < noBody.length; i += BODY_CONCURRENCY) {
    const batch = noBody.slice(i, i + BODY_CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const body = await fetchBody(row.url);
        q.updateBodyRaw.run({ $id: row.id, $body_raw: body });
      })
    );
  }

  console.log(`[info] Body fetch complete`);

  // ── Step 3: 要約・スコアリング ────────────────────────
  const unsummarized = q.selectUnsummarized.all();
  console.log(`[info] Summarizing ${unsummarized.length} articles...`);

  if (unsummarized.length > 0) {
    try {
      const result = await summarizeBatch(unsummarized, (row) => q.insertSummary.run(row));
      console.log(`\n[done] Summaries saved: ${result.saved}, errors: ${result.errors}`);
    } catch (err) {
      if (err instanceof ClaudeAuthError) {
        console.error(`\n[fatal] ${err.message}`);
        // 認証エラーは Slack アラート送信（Phase 5 で実装）
        process.exit(1);
      }
      throw err;
    }
  }

  console.log(`[done] Pipeline complete`);
  db.close();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
