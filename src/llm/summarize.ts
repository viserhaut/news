import { callClaude, ClaudeAuthError } from "./claude";
import type { UnsummarizedRow, SummaryInsert } from "../db/queries";

const BATCH_SIZE = 10;
// レート制限対策: バッチ間のスリープ（ms）
const BATCH_SLEEP_MS = 3_000;
// エラー時のリトライ待機（ms）
const RETRY_SLEEP_MS = 15_000;

// AI スコアと新しさの配合比（確定パラメータ）
const AI_WEIGHT = 0.7;
const RECENCY_WEIGHT = 0.3;
// 指数減衰の係数 λ: 今日=1.0, 3日前≈0.41, 7日前≈0.12
const RECENCY_LAMBDA = 0.3;

// ---- スコア計算 ----

function recencyScore(published_at: string | null): number {
  if (!published_at) return 0.5; // 日付不明は中間値
  const ageMs = Date.now() - new Date(published_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-RECENCY_LAMBDA * ageDays);
}

export function finalScore(aiScore: number, published_at: string | null): number {
  return aiScore * AI_WEIGHT + recencyScore(published_at) * RECENCY_WEIGHT;
}

// ---- プロンプト生成 ----

interface ArticleInput {
  id: number;
  title: string;
  source: string;
  body: string | null;
}

interface SummaryOutput {
  id: number;
  title_ja: string;
  summary_ja: string;
  detail_summary_ja: string;
  ai_score: number;
}

function buildPrompt(articles: ArticleInput[], personalContext?: string | null): string {
  // 記事コンテンツは JSON.stringify で自動エスケープ（プロンプトインジェクション緩和）
  const articlesJson = JSON.stringify(articles, null, 2);

  // Layer3: パーソナライズコンテキストがあれば挿入
  const personalSection = personalContext
    ? `\n${personalContext}\n`
    : "";

  return `あなたはSREエンジニアかつAIエージェント個人開発者のためのニュースキュレーターです。

ユーザーの関心領域:
- 本業SRE: Kubernetes, IaC (Terraform/Pulumi), Observability, セキュリティ
- AIエージェント開発: Claude, LLM, MCP, Claude Code
- 個人開発・副業・収益化: インディーハッカー, SaaS, プロダクト開発
- プロダクト設計・PDM: ユーザー課題発見, MVP定義, プロダクト戦略
- 日本市場: 国内スタートアップ動向, 日本語SaaS, 日本未上陸サービス
${personalSection}
以下の記事リストを読み、各記事に対してJSON配列を返してください。
説明文・マークダウン・コードブロックは一切不要です。JSONのみを出力してください。

## スコアリング基準 (ai_score: 0.0〜1.0)
- 0.85〜1.0: 上記関心領域に直結。実践的な示唆・新情報がある
- 0.60〜0.84: 関連分野の周辺情報。把握しておく価値あり
- 0.30〜0.59: 薄い関連。読むか判断が必要
- 0.00〜0.29: ほぼ無関係

## カテゴリ別スコアリング補足
- indie_dev: 「月10万円規模で個人実装可能か」「既存サービスの改善・組み合わせか」「Pain Pointが明確か」を重視
- product: 「ユーザー課題の発見・解決フレームワークか」「PDM視点での再現可能な知見か」を重視
- japan_biz: 「日本市場固有の機会か」「日本未上陸カテゴリのタイムマシン戦略に使えるか」を重視

## 出力フォーマット（JSON配列のみ）
[
  {
    "id": <元のid>,
    "title_ja": "日本語タイトル（簡潔に）",
    "summary_ja": "3〜5文の日本語要約。記事のタイトルや出典の説明ではなく、**記事の中で最も重要な事実・数値・技術的ポイント・結論**を書く。読者が記事を読まなくてもキーポイントを把握できるよう、具体的な内容を含める。",
    "detail_summary_ja": "箇条書き10点以内の詳細サマリー。各点は「・」で始める。重要な技術的詳細・背景・影響を含める。",
    "ai_score": 0.85
  }
]

## 記事リスト
${articlesJson}`;
}

// ---- JSON レスポンスパース ----

function parseResponse(raw: string): SummaryOutput[] {
  // Claude が JSON 以外のテキストを前後に付けることがあるため、配列部分のみ抽出
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON array found in Claude response: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  return parsed.map((item: any) => ({
    id: Number(item.id),
    title_ja: String(item.title_ja ?? ""),
    summary_ja: String(item.summary_ja ?? ""),
    detail_summary_ja: String(item.detail_summary_ja ?? ""),
    ai_score: Math.max(0, Math.min(1, Number(item.ai_score ?? 0))),
  }));
}

// ---- バッチ実行 ----

export interface SummarizeResult {
  saved: number;
  errors: number;
}

export async function summarizeBatch(
  articles: UnsummarizedRow[],
  insertSummary: (row: SummaryInsert) => void,
  personalContext?: string | null
): Promise<SummarizeResult> {
  let saved = 0;
  let errors = 0;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(articles.length / BATCH_SIZE);

    console.log(`[llm] Batch ${batchNum}/${totalBatches} (${batch.length} articles)...`);

    const inputs: ArticleInput[] = batch.map((a) => ({
      id: a.id,
      title: a.title,
      source: a.source_id,
      body: a.body_raw,
    }));

    try {
      const prompt = buildPrompt(inputs, personalContext);
      // タイムアウト・レート制限時に1回リトライ
      let raw: string;
      try {
        raw = await callClaude(prompt);
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const isRetryable =
          msg.includes("code 143") ||
          msg.includes("SIGTERM") ||
          msg.includes("code 1");
        if (isRetryable) {
          console.warn(`[llm] Batch ${batchNum} failed, retrying in ${RETRY_SLEEP_MS / 1000}s...`);
          await Bun.sleep(RETRY_SLEEP_MS);
          raw = await callClaude(prompt);
        } else {
          throw firstErr;
        }
      }
      const outputs = parseResponse(raw);

      // id でマップして保存
      const outputMap = new Map(outputs.map((o) => [o.id, o]));
      for (const article of batch) {
        const out = outputMap.get(article.id);
        if (!out) {
          console.warn(`[llm] No summary for article id=${article.id}`);
          errors++;
          continue;
        }
        const score = finalScore(out.ai_score, article.published_at);
        insertSummary({
          $article_id: article.id,
          $title_ja: out.title_ja,
          $summary_ja: out.summary_ja,
          $detail_summary_ja: out.detail_summary_ja || null,
          $ai_score: score,
        });
        saved++;
      }

      console.log(`[llm] Batch ${batchNum} done: ${outputs.length} summaries`);

      // バッチ間スリープ（レート制限対策）
      if (i + BATCH_SIZE < articles.length) {
        await Bun.sleep(BATCH_SLEEP_MS);
      }
    } catch (err) {
      if (err instanceof ClaudeAuthError) {
        // 認証切れは致命的エラー — 即座に上位に伝播
        throw err;
      }
      console.error(`[llm] Batch ${batchNum} error: ${err instanceof Error ? err.message : err}`);
      errors += batch.length;
    }
  }

  return { saved, errors };
}
