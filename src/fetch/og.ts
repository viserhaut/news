const OG_TIMEOUT_MS = 10_000;

const USER_AGENT =
  "Mozilla/5.0 (compatible; news-digest/1.0; +https://github.com/viserhaut/news)";

/**
 * 記事 URL から OGP 画像 URL を取得する。
 * - https:// のみ返す（Mixed Content・SSRF 防止）
 * - エラー時・非 https 時: null を返す
 */
export async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OG_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return extractOgImage(html);
  } catch {
    return null;
  }
}

function extractOgImage(html: string): string | null {
  // property="og:image" content="..." の2通りの属性順に対応
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const imgUrl = m?.[1]?.trim() ?? null;
  if (!imgUrl) return null;
  // https:// のみ許可（Mixed Content・SSRF 防止）
  if (!imgUrl.startsWith("https://")) return null;
  try {
    new URL(imgUrl);
  } catch {
    return null;
  }
  return imgUrl;
}
