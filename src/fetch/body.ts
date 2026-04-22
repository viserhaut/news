const BODY_TIMEOUT_MS = 15_000;
const FULL_TEXT_THRESHOLD = 400;
const HEAD_CHARS = 300;

const USER_AGENT =
  "Mozilla/5.0 (compatible; news-digest/1.0; +https://github.com/viserhaut/news)";

/**
 * 記事 URL から本文テキストを取得する。
 * - 800 字以下: 全文
 * - 800 字超: 先頭 500 字 + 末尾 300 字 (Head+Tail)
 * - エラー時: null を返す（呼び出し元でスキップ）
 */
export async function fetchBody(url: string): Promise<string | null> {
  try {
    const html = await fetchHtml(url);
    const text = extractText(html);
    return headTail(text);
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** HTML タグを除去してテキストを抽出（軽量版） */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function headTail(text: string): string {
  if (text.length <= FULL_TEXT_THRESHOLD) return text;
  return text.slice(0, HEAD_CHARS);
}
