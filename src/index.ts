import { join } from "path";
import { mkdirSync } from "fs";
import { initDb } from "./db/schema";
import { makeQueries } from "./db/queries";
import { loadSources } from "./config/sources";
import { fetchSource } from "./fetch/rss";

const ROOT_DIR = join(import.meta.dir, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT_DIR, "data", "digest.db");

async function main() {
  // data/ ディレクトリを確保
  mkdirSync(join(ROOT_DIR, "data"), { recursive: true });

  const db = initDb(DB_PATH);
  const q = makeQueries(db);

  // 期限切れ記事を削除
  q.deleteExpired.run();

  const sources = loadSources(ROOT_DIR);
  console.log(`[info] ${sources.length} sources loaded`);

  // 全ソースを並列フェッチ（ソースごと独立エラーハンドリング）
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
      const before = (q.countArticlesBySource.get({ $source_id: article.$source_id }) as { count: number })?.count ?? 0;
      q.insertArticle.run(article);
      const after = (q.countArticlesBySource.get({ $source_id: article.$source_id }) as { count: number })?.count ?? 0;
      if (after > before) newCount++;
    }

    totalNew += newCount;
    console.log(
      `[ok]    ${result.source_id}: ${result.articles.length} fetched, ${newCount} new`
    );
  }

  console.log(`\n[done] Total new articles: ${totalNew}`);
  db.close();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
