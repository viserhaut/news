import type { DigestArticleRow } from "../db/queries";

const WEBHOOK_ENV = "SLACK_WEBHOOK_URL";
const MAX_SUMMARY_LINE = 60;
const TOP_N = 5;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function postSlack(url: string, text: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  }
}

/**
 * 毎日のダイジェスト通知を Slack に送信する。
 * - 新着件数・上位 5 記事タイトル・Web UI リンクを送信
 * - SLACK_WEBHOOK_URL 未設定なら何もしない（エラーにしない）
 */
export async function notifyDigest(
  articles: DigestArticleRow[],
  newCount: number
): Promise<void> {
  const webhookUrl = process.env[WEBHOOK_ENV];
  if (!webhookUrl) return;

  const today = new Date().toLocaleDateString("ja-JP", {
    month: "numeric",
    day: "numeric",
  });

  const top = articles.slice(0, TOP_N);
  const bullets = top
    .map((a) => `• ${truncate(a.title_ja ?? a.url, MAX_SUMMARY_LINE)}`)
    .join("\n");

  const text = [
    `📰 ダイジェスト更新 (${today})`,
    `新着 ${newCount}件 | https://news.viserhaut.com`,
    "",
    "🔥 注目トピック",
    bullets,
  ].join("\n");

  await postSlack(webhookUrl, text);
}

/**
 * エラーアラートを Slack に送信する。
 * - 内部パスやスタックトレースは含めない（メタデータのみ）
 */
export async function notifyError(label: string, code?: string): Promise<void> {
  const webhookUrl = process.env[WEBHOOK_ENV];
  if (!webhookUrl) return;

  const text = code
    ? `⚠️ ニュースダイジェスト エラー\n${label} (${code})`
    : `⚠️ ニュースダイジェスト エラー\n${label}`;

  try {
    await postSlack(webhookUrl, text);
  } catch {
    // エラー通知の失敗はログのみ（再帰的なエラーを防ぐ）
    console.error("[slack] Failed to send error notification");
  }
}
