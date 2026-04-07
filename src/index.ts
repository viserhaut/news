import { join } from "path";
import { mkdirSync } from "fs";
import { initDb } from "./db/schema";
import { makeQueries } from "./db/queries";
import { loadSources } from "./config/sources";
import { fetchSource } from "./fetch/rss";
import { fetchBody } from "./fetch/body";
import { fetchOgImage } from "./fetch/og";
import { summarizeBatch } from "./llm/summarize";
import { ClaudeAuthError } from "./llm/claude";
import { computeTagAffinity, applyTagBoost } from "./personalize/layer1";
import { maybeGenerateProfile } from "./personalize/layer2";
import { buildPersonalContext } from "./personalize/inject";
import { notifyDigest, notifyError } from "./notify/slack";
import type { DigestArticleRow } from "./db/queries";

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
        const [body, ogImage] = await Promise.all([
          fetchBody(row.url),
          fetchOgImage(row.url),
        ]);
        q.updateBodyRaw.run({ $id: row.id, $body_raw: body });
        q.updateOgImage.run({ $id: row.id, $og_image: ogImage });
      })
    );
  }

  console.log(`[info] Body fetch complete`);

  // ── Step 3: 要約・スコアリング ────────────────────────
  const unsummarized = q.selectUnsummarized.all();
  console.log(`[info] Summarizing ${unsummarized.length} articles...`);

  if (unsummarized.length > 0) {
    try {
      // Layer3: パーソナライズコンテキストを構築してプロンプトに注入
      const affinityRows = q.selectReadCountByCategory.all();
      const tagAffinity = computeTagAffinity(affinityRows);
      const latestProfile = q.selectLatestProfile.get() as { profile: string; based_on: number } | null;
      const preferences = q.selectUserPreferences.all() as Array<{ type: string; value: string }>;
      const personalContext = buildPersonalContext(tagAffinity, latestProfile?.profile ?? null, preferences);

      const result = await summarizeBatch(
        unsummarized,
        (row) => q.insertSummary.run(row),
        personalContext
      );
      console.log(`\n[done] Summaries saved: ${result.saved}, errors: ${result.errors}`);
    } catch (err) {
      if (err instanceof ClaudeAuthError) {
        console.error(`\n[fatal] ${err.message}`);
        await notifyError("Claude認証エラー: 再認証が必要です", "AUTH_ERROR");
        process.exit(1);
      }
      throw err;
    }
  }

  // ── Step 4: Layer1 タグブースト → personal_score 更新 ──
  const summariesForBoost = q.selectSummariesForBoost.all() as Array<{
    article_id: number;
    ai_score: number;
    category: string;
  }>;
  const affinityRows = q.selectReadCountByCategory.all();
  const tagAffinity = computeTagAffinity(affinityRows);
  const boosted = applyTagBoost(summariesForBoost, tagAffinity, (id, score) => {
    q.updatePersonalScore.run({ $article_id: id, $personal_score: score });
  });
  console.log(`[personalize] Layer1: ${boosted} personal_scores updated`);

  // ── Step 5: Layer2 セマンティックプロファイル更新（必要時のみ）──
  const recentReads = q.selectRecentReads.all();
  const latestProfile = q.selectLatestProfile.get() as { profile: string; based_on: number } | null;
  const totalReads = (q.countReadHistory.get() as { count: number })?.count ?? 0;
  await maybeGenerateProfile(
    recentReads,
    latestProfile,
    totalReads,
    (profile, basedOn) => q.insertSemanticProfile.run({ $profile: profile, $based_on: basedOn })
  );

  // ── Step 6: HTML 生成 ────────────────────────────────
  const { generateHtml } = await import("./generate/html");
  await generateHtml(db, q, ROOT_DIR);
  console.log("[done] HTML generated → docs/index.html");

  // ── Step 7: Slack 通知 ───────────────────────────────
  const digestArticles = q.selectDigestArticles.all();
  // Slack 通知は48時間以内の記事のみ（古い記事が Top5 に入り込むのを防ぐ）
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentArticles = (digestArticles as DigestArticleRow[]).filter((a) => {
    if (!a.published_at) return true;
    return new Date(a.published_at).getTime() > cutoff;
  });
  await notifyDigest(recentArticles, totalNew).catch((err) => {
    console.error("[slack] Notification failed:", err instanceof Error ? err.message : err);
  });

  console.log(`[done] Pipeline complete`);
  db.close();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
