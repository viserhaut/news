import { XMLParser } from "fast-xml-parser";
import { createHash } from "crypto";
import type { Source } from "../config/sources";
import type { ArticleInsert } from "../db/queries";

const FETCH_TIMEOUT_MS = 10_000;

const USER_AGENT =
  "Mozilla/5.0 (compatible; news-digest/1.0; +https://github.com/viserhaut/news)";

export interface FetchResult {
  source_id: string;
  articles: ArticleInsert[];
  error?: string;
}

export async function fetchSource(source: Source): Promise<FetchResult> {
  try {
    const xml = await fetchXml(source.rss_url);
    const articles = parseXml(xml, source);
    return { source_id: source.id, articles };
  } catch (err) {
    return {
      source_id: source.id,
      articles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => ["item", "entry"].includes(name),
  // デフォルト 1000 では一部フィードがエラーになるため引き上げ
  processEntities: { maxTotalExpansions: 10000 },
  // デフォルト 100 では Indie Hackers 等で超過するため引き上げ
  maxNestedTags: 500,
});

function parseXml(xml: string, source: Source): ArticleInsert[] {
  const parsed = xmlParser.parse(xml);

  // RSS 2.0
  if (parsed.rss?.channel) {
    return parseRss2(parsed.rss.channel, source);
  }

  // Atom 1.0
  if (parsed.feed) {
    return parseAtom(parsed.feed, source);
  }

  // RSS 1.0 (RDF) — はてなブックマーク等
  if (parsed["rdf:RDF"]) {
    return parseRss2(parsed["rdf:RDF"], source);
  }

  throw new Error("Unknown feed format (not RSS2.0, Atom, or RDF)");
}

function parseRss2(channel: any, source: Source): ArticleInsert[] {
  const items: any[] = Array.isArray(channel.item) ? channel.item : [];
  return items
    .slice(0, source.max_items)
    .map((item) => {
      const url = extractText(item.link) ?? extractText(item.guid);
      const title = extractText(item.title);
      if (!url || !title) return null;
      const published_at = parseDate(
        extractText(item.pubDate) ?? extractText(item["dc:date"])
      );
      return {
        $url_hash: sha256(url),
        $url: url,
        $title: title,
        $source_id: source.id,
        $language: source.language,
        $category: source.category,
        $published_at: published_at,
        $body_raw: null,
      } satisfies ArticleInsert;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

function parseAtom(feed: any, source: Source): ArticleInsert[] {
  const entries: any[] = Array.isArray(feed.entry) ? feed.entry : [];
  return entries
    .slice(0, source.max_items)
    .map((entry) => {
      // Atom <link> は href 属性または配列
      const url = extractAtomLink(entry.link);
      const title = extractText(entry.title);
      if (!url || !title) return null;
      const published_at = parseDate(
        extractText(entry.published) ?? extractText(entry.updated)
      );
      return {
        $url_hash: sha256(url),
        $url: url,
        $title: title,
        $source_id: source.id,
        $language: source.language,
        $category: source.category,
        $published_at: published_at,
        $body_raw: null,
      } satisfies ArticleInsert;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return decodeEntities(v.trim()) || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (obj["#text"]) return decodeEntities(String(obj["#text"]).trim()) || null;
  }
  return null;
}

function extractAtomLink(link: unknown): string | null {
  if (!link) return null;
  if (typeof link === "string") return link.trim() || null;
  if (Array.isArray(link)) {
    // rel="alternate" を優先
    const alt = link.find((l: any) => l["@_rel"] === "alternate" || !l["@_rel"]);
    return alt?.["@_href"] ?? link[0]?.["@_href"] ?? null;
  }
  if (typeof link === "object") {
    const obj = link as Record<string, unknown>;
    return (obj["@_href"] as string) ?? extractText(obj) ?? null;
  }
  return null;
}

function parseDate(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
