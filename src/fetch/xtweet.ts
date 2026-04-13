import { createHash } from "crypto";

const XAI_ENDPOINT = "https://api.x.ai/v1/responses";
const XAI_MODEL = "grok-4-1-fast-non-reasoning";
const XAI_TIMEOUT_MS = 30_000;

export interface TweetFetchResult {
  url: string;
  url_hash: string;
  text: string;          // スレッド全文
  linked_urls: string[]; // ツイート内リンク
}

/**
 * xAI API（x_search ツール）でツイートスレッド全文と linked_urls を取得する。
 * エラー時は null を返す。
 */
export async function fetchTweetThread(
  tweetUrl: string,
  apiKey: string
): Promise<TweetFetchResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), XAI_TIMEOUT_MS);
    let rawText: string;
    try {
      const res = await fetch(XAI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          tools: [{ type: "x_search" }],
          input:
            `このツイートのスレッド全文（本文・リプライ含む）をそのまま返してください。要約不要。` +
            `JSON形式で: {"text": "全文", "linked_urls": ["リンクURL"]}。URL: ${tweetUrl}`,
          max_output_tokens: 2000,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`xAI API HTTP ${res.status}`);
      const data = (await res.json()) as XaiResponse;
      rawText = extractText(data);
    } finally {
      clearTimeout(timer);
    }

    // JSON 部分を抽出してパース
    const jsonMatch = rawText.match(/\{[\s\S]*"text"[\s\S]*"linked_urls"[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSON not found in response");
    const parsed = JSON.parse(jsonMatch[0]) as { text: string; linked_urls: string[] };
    if (typeof parsed.text !== "string") throw new Error("Invalid response structure");

    return {
      url: tweetUrl,
      url_hash: sha256(tweetUrl),
      text: parsed.text,
      linked_urls: Array.isArray(parsed.linked_urls) ? parsed.linked_urls : [],
    };
  } catch (err) {
    console.error(
      `[xtweet] Failed to fetch ${tweetUrl}: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

interface XaiOutput {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface XaiResponse {
  output?: XaiOutput[];
}

function extractText(data: XaiResponse): string {
  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) return c.text;
      }
    }
  }
  throw new Error("No text output in xAI response");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
