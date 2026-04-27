import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { DigestArticleRow } from "../db/queries";
import { initDb } from "../db/schema";
import { makeQueries } from "../db/queries";

type Queries = ReturnType<typeof import("../db/queries").makeQueries>;

// ── ユーティリティ ────────────────────────────────────
function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function safeUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return "";
  return esc(url);
}

function formatDate(isoStr: string | null): string {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  } catch {
    return "";
  }
}

// ── ティア定義 ───────────────────────────────────────
const TIERS = [
  { id: "must-read",    label: "Must Read",    color: "#1748a8", min: 0.85 },
  { id: "recommended",  label: "Recommended",  color: "#4a6a3a", min: 0.70 },
  { id: "worth-a-look", label: "Worth a Look", color: "#a8741a", min: 0.50 },
  { id: "low-priority", label: "Low Priority", color: "#8a8174", min: 0.00 },
] as const;

type Tier = (typeof TIERS)[number];

function getTier(score: number): Tier {
  for (const t of TIERS) {
    if (score >= t.min) return t;
  }
  return TIERS[TIERS.length - 1]!;
}

const FEED_COLOR: Record<string, string> = {
  anthropic_blog: "#cc785c", openai_blog: "#10a37f", cloudflare_blog: "#f6821f",
  bun_sh: "#d97aa6", vercel_blog: "#0f172a", hono_dev: "#ff6b35",
  mcp_spec: "#6d4ec7", postgres_news: "#336791", github_blog: "#24292e",
  aws_blog: "#cc7a00", hashicorp_blog: "#5b3aa8", cncf_blog: "#3970e4",
  zenn_trending: "#3b82f6", cisa_news: "#1e3a8a", openssh_news: "#5a5a5a",
  x: "#1a1a1a",
};
const feedColor = (f: string) => FEED_COLOR[f] ?? "#7a6f5d";

// ── カテゴリラベル ────────────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  ai: "AI",
  cloud: "クラウド",
  sre: "SRE",
  security: "セキュリティ",
  dev: "開発",
  indie: "個人開発",
  news: "ニュース",
  ai_tools: "AIツール",
  ai_research: "AI研究",
  community: "コミュニティ",
  other: "その他",
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat;
}

// ── 要約を箇条書きに変換 ──────────────────────────────
function summaryHtml(summary: string | null | undefined): string {
  if (!summary) return "";
  // 「。」で文を分割して箇条書きに
  const sentences = summary
    .split(/。(?!」|』|\s*$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 1) {
    return `<p class="card-summary">${esc(summary)}</p>`;
  }
  const items = sentences.map((s) => `<li>${esc(s)}。</li>`).join("");
  return `<ul class="card-summary-list">${items}</ul>`;
}

// ── カード HTML ───────────────────────────────────────
function cardHtml(a: DigestArticleRow): string {
  const score = typeof a.personal_score === "number" ? a.personal_score : 0;
  const scorePct = Math.round(score * 100);
  // X ブックマークは手動選択のため常に Must Read
  const tier = a.source_id === "x" ? TIERS[0]! : getTier(score);
  const fc = feedColor(a.source_id);
  const initial = (a.source_id ?? "?")[0]!.toUpperCase();
  const title = esc(a.title_ja ?? a.url);
  const published = formatDate(a.published_at);

  return `<article class="card${a.detail_summary_ja ? " has-detail" : ""}" data-id="${a.id}" data-category="${esc(a.category)}" data-tier="${tier.id}" data-date="${esc(a.published_at ?? "")}"${a.detail_summary_ja ? ` data-detail="${esc(a.detail_summary_ja)}" data-url="${safeUrl(a.url)}" data-title="${esc(a.title_ja ?? a.url)}" data-summary="${esc(a.summary_ja ?? "")}"` : ""}>
  <div class="c-row">
    <div class="c-head">
      <span class="feed-avatar" style="background:${fc}">${initial}</span>
      <span class="feed-name">${esc(a.source_id)}</span>
      <span class="meta-sep">·</span>
      <span>${published}</span>
      <span class="tag">${esc(categoryLabel(a.category))}</span>
    </div>
    <h3 class="c-title"><a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
    ${a.summary_ja ? `<p class="c-summary">${esc(a.summary_ja)}</p>` : ""}
    <div class="c-actions">
      <button type="button" class="icon-btn" data-action="read" aria-label="既読にする">✓</button>
      <button type="button" class="icon-btn bookmark" data-action="bookmark" aria-label="ブックマーク">☆</button>
      <button type="button" class="icon-btn skip" data-action="skip" aria-label="スキップ">✕</button>
      <button type="button" class="icon-btn share-btn" data-action="share" data-share-url="${safeUrl(a.url)}" data-share-title="${title}" aria-label="シェア">↗</button>
      <span class="c-score">
        <span class="score-bar"><span class="score-fill" style="width:${scorePct}%;background:${tier.color}"></span></span>
        relevance ${scorePct}
      </span>
    </div>
  </div>
</article>`;
}

// ── ティアセクション HTML ─────────────────────────────
function tierSectionHtml(tier: Tier, cards: DigestArticleRow[]): string {
  const tierId = tier.id.replace(/-/g, "_");
  const cardsHtml = cards.map(cardHtml).join("\n");
  return `<section id="${tier.id}" class="tier-section" data-tier="${tierId}">
  <div class="tier-divider">
    <span class="tier-mark">${tier.label[0]}</span>
    <span class="tier-eyebrow"><strong>${tier.label}</strong></span>
    <span class="tier-count">${cards.length} articles</span>
    <div class="tier-actions">
      <button type="button" class="section-btn mark-section-read">全て既読</button>
      <button type="button" class="section-btn skip skip-section-btn">スキップ</button>
    </div>
  </div>
  <div class="cards">
    ${cardsHtml}
  </div>
</section>`;
}

// ── CSS (Editorial Paper × Collapsible Rail) ──────────
const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --serif: 'Charter', 'Iowan Old Style', 'Georgia', 'Hiragino Mincho ProN', 'Yu Mincho', serif;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
  --rail-w-collapsed: 64px; --rail-w-expanded: 280px;
  --feed-w: 760px; --header-h: 64px;
}

:root, [data-theme="light"], [data-theme="dark"] {
  --paper: #f5f1ea; --paper-tint: #efe9dd; --paper-edge: #e6dfd0;
  --rule: #c9c0b1; --ink: #1a1814; --ink-soft: #3a342c;
  --ink-mute: #7a6f5d; --ink-faint: #a89f8d;
  --ink-blue: #1748a8; --ink-blue-soft: #2d63c8;
  --tier-must-read: #1748a8; --tier-recommended: #4a6a3a;
  --tier-worth-a-look: #a8741a; --tier-low-priority: #8a8174;
  --bg: var(--paper); --surface: #fbf8f1; --surface-hover: #f0ead9;
  --border: var(--paper-edge); --border-light: var(--rule);
  --text: var(--ink); --text-muted: var(--ink-soft); --text-dim: var(--ink-mute);
  --accent: var(--ink-blue); --accent-light: var(--ink-blue-soft);
  --accent-glow: rgba(23,72,168,0.06);
  --tag-bg: rgba(23,72,168,0.06); --tag-text: var(--ink-blue);
  --bookmark: #a8741a; --danger: #a83232; --success: #4a6a3a;
}

html, body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--font-sans); font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
button, input { font-family: inherit; }
a { color: inherit; }

/* ── App shell ──────────────────────────────────────────────────────── */
.app { display: grid; grid-template-columns: var(--rail-w-collapsed) 1fr; min-height: 100vh; transition: grid-template-columns 0.22s cubic-bezier(0.32,0.72,0,1); }
.app.expanded { grid-template-columns: var(--rail-w-expanded) 1fr; }

/* ── Rail (sidebar) ─────────────────────────────────────────────────── */
.rail { position: sticky; top: 0; height: 100vh; border-right: 1px solid var(--rule); background: var(--paper-tint); display: flex; flex-direction: column; overflow: hidden; }
.rail-top { padding: 18px 12px; display: flex; flex-direction: column; gap: 4px; align-items: stretch; overflow-y: auto; flex: 1; scrollbar-width: none; }
.rail-top::-webkit-scrollbar { display: none; }
.rail-mark { width: 40px; height: 40px; border: 1px solid var(--ink); display: grid; place-content: center; font-family: var(--serif); font-style: italic; font-weight: 700; font-size: 18px; color: var(--ink); margin: 0 auto 12px; transition: all 0.15s ease; cursor: pointer; user-select: none; }
.rail-mark:hover { background: var(--ink); color: var(--paper); }
.app.expanded .rail-mark { margin: 0 0 12px; }

.rail-icon { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border: none; background: transparent; color: var(--ink-mute); cursor: pointer; border-radius: 4px; font-size: 14px; transition: background 0.12s ease, color 0.12s ease; white-space: nowrap; width: 100%; text-align: left; text-decoration: none; }
.rail-icon:hover { background: rgba(0,0,0,0.04); color: var(--ink); }
.rail-icon.active { color: var(--ink-blue); background: var(--accent-glow); }
.rail-glyph { width: 20px; flex-shrink: 0; text-align: center; font-size: 15px; }
.rail-label { font-family: var(--serif); font-size: 14px; opacity: 0; transition: opacity 0.18s ease; pointer-events: none; }
.app.expanded .rail-label { opacity: 1; pointer-events: auto; }
.rail-count { margin-left: auto; font-size: 11px; color: var(--ink-faint); font-variant-numeric: tabular-nums; opacity: 0; transition: opacity 0.18s ease; }
.app.expanded .rail-count { opacity: 1; }

.rail-divider { height: 1px; background: var(--paper-edge); margin: 12px 14px; }
.rail-section-label { font-family: var(--serif); font-style: italic; font-size: 11px; color: var(--ink-faint); padding: 0 14px 6px; opacity: 0; transition: opacity 0.18s ease; letter-spacing: 0.04em; white-space: nowrap; }
.app.expanded .rail-section-label { opacity: 1; }

.rail-search { margin: 8px 12px 0; padding: 7px 10px; border: 1px solid var(--paper-edge); background: var(--paper); color: var(--ink); border-radius: 4px; font-size: 13px; outline: none; opacity: 0; transition: opacity 0.18s ease, border-color 0.12s ease; pointer-events: none; }
.app.expanded .rail-search { opacity: 1; pointer-events: auto; }
.rail-search:focus { border-color: var(--ink-blue); }

.rail-foot { padding: 12px; border-top: 1px solid var(--paper-edge); }
.rail-foot-text { font-family: var(--serif); font-style: italic; font-size: 11px; color: var(--ink-faint); text-align: center; opacity: 0; transition: opacity 0.18s ease; }
.app.expanded .rail-foot-text { opacity: 1; }

.settings-btn-wrap { position: relative; display: inline-flex; }
.sync-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--paper-tint); background: var(--paper-edge); pointer-events: none; transition: background 0.2s ease; }
.sync-dot.ok      { background: var(--success); }
.sync-dot.error   { background: var(--danger); }
.sync-dot.syncing { background: var(--ink-blue); animation: pulse-dot 1s ease-in-out infinite; }
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.export-btn { display: block; width: 100%; padding: 7px 10px; background: none; border: none; color: var(--ink-mute); font-family: var(--serif); font-style: italic; font-size: 13px; cursor: pointer; text-align: left; border-radius: 4px; transition: color 0.12s ease; }
.export-btn:hover { color: var(--ink); }

/* ── Main content ───────────────────────────────────────────────────── */
main { padding: 0; min-width: 0; }

.masthead { position: sticky; top: 0; z-index: 4; background: rgba(245,241,234,0.88); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--rule); }
.masthead-inner { max-width: var(--feed-w); margin: 0 auto; padding: 22px 24px 14px; }
.brand-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.wordmark { font-family: var(--serif); font-weight: 700; font-size: 28px; letter-spacing: -0.02em; color: var(--ink); line-height: 1; }
.wordmark .ampersand { font-style: italic; font-weight: 400; color: var(--ink-blue); padding: 0 2px; }
.masthead-date { font-family: var(--serif); font-style: italic; font-size: 13px; color: var(--ink-mute); }
.masthead-rule { height: 1px; background: var(--ink); margin: 14px 0 12px; }

.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 5px 12px; border-radius: 999px; font-size: 12px; border: 1px solid var(--paper-edge); background: var(--paper); color: var(--ink-mute); cursor: pointer; font-family: var(--serif); transition: all 0.12s ease; }
.chip:hover { border-color: var(--ink); color: var(--ink); }
.chip.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }

/* ── Feed ───────────────────────────────────────────────────────────── */
.feed { max-width: var(--feed-w); margin: 0 auto; padding: 40px 32px 96px; }

@media (min-width: 1280px) {
  :root { --feed-w: 820px; }
  .c-title { font-size: 34px; line-height: 1.22; }
  .c-summary { font-size: 19px; }
  .wordmark { font-size: 32px; }
  .feed { padding: 48px 32px 96px; }
  .card { padding: 32px 0 34px 28px; }
  .tier-eyebrow { font-size: 38px; }
  .tier-mark { width: 52px; height: 52px; font-size: 26px; }
}

.tier-section { margin-bottom: 16px; position: relative; }
.tier-section[data-tier="must_read"]      { --tier-c: #1748a8; }
.tier-section[data-tier="recommended"]    { --tier-c: #4a6a3a; }
.tier-section[data-tier="worth_a_look"]   { --tier-c: #a8741a; }
.tier-section[data-tier="low_priority"]   { --tier-c: #8a8174; }

.tier-divider { display: flex; align-items: center; gap: 18px; margin: 64px 0 24px; padding-bottom: 16px; border-bottom: 2px solid var(--ink); position: relative; }
.tier-section:first-child .tier-divider { margin-top: 8px; }
.tier-divider::before { content: ""; position: absolute; left: 0; bottom: -2px; width: 80px; height: 4px; background: var(--tier-c); }

.tier-mark { width: 44px; height: 44px; border-radius: 50%; background: var(--tier-c); color: var(--paper); font-family: var(--serif); font-style: italic; font-weight: 700; font-size: 22px; display: grid; place-content: center; flex-shrink: 0; letter-spacing: -0.02em; }
.tier-eyebrow { font-family: var(--serif); font-size: 32px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1; }
.tier-count { font-family: var(--font-sans); font-size: 13px; color: var(--ink-mute); font-variant-numeric: tabular-nums; letter-spacing: 0.04em; text-transform: uppercase; }
.tier-actions { display: flex; gap: 18px; margin-left: auto; }
.section-btn { background: none; border: none; color: var(--ink-mute); font-size: 14px; cursor: pointer; font-family: var(--serif); font-style: italic; padding: 0; transition: color 0.12s ease; }
.section-btn:hover { color: var(--ink); }
.section-btn.skip:hover { color: var(--danger); }

/* ── Card ───────────────────────────────────────────────────────────── */
.cards { display: flex; flex-direction: column; }
.card { padding: 28px 0 30px 24px; border-bottom: 1px solid var(--paper-edge); position: relative; transition: opacity 0.2s ease; border-left: 3px solid var(--tier-c); margin-left: -8px; }
.tier-section[data-tier="low_priority"] .card { border-left-color: var(--paper-edge); }
.card:last-child { border-bottom: none; }
.card.read { opacity: 0.4; }
.card.read:hover { opacity: 0.75; }
.card.has-detail { cursor: pointer; }
.card.focused { outline: 2px solid var(--ink-blue); outline-offset: 2px; }

.c-row { display: flex; flex-direction: column; gap: 0; }
.c-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 13px; color: var(--ink-mute); font-family: var(--serif); }
.feed-avatar { width: 24px; height: 24px; border-radius: 50%; display: grid; place-content: center; color: var(--paper); font-size: 11px; font-weight: 700; flex-shrink: 0; font-family: var(--font-sans); }
.feed-name { color: var(--ink); font-weight: 600; font-family: var(--font-sans); font-size: 13px; }
.c-head .meta-sep { color: var(--ink-faint); }
.tag { font-family: var(--font-sans); font-size: 11px; padding: 1px 7px; border-radius: 3px; background: var(--tag-bg); color: var(--tag-text); letter-spacing: 0.02em; }
.badge-new { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 2px; background: var(--ink-blue); color: var(--paper); text-transform: uppercase; font-family: var(--font-sans); margin-left: 2px; }

.c-title { font-family: var(--serif); font-size: 30px; font-weight: 700; line-height: 1.25; letter-spacing: -0.015em; margin: 0 0 12px; color: var(--ink); }
.c-title a { color: inherit; text-decoration: none; }
.card.has-detail:hover .c-title a, .card:hover .c-title a { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; text-decoration-color: var(--ink-faint); }

.c-summary { font-family: var(--serif); font-size: 18px; line-height: 1.6; color: var(--ink-soft); margin: 0 0 18px; }

.c-actions { display: flex; align-items: center; gap: 4px; }
.icon-btn { width: 32px; height: 32px; border: none; background: transparent; border-radius: 50%; cursor: pointer; color: var(--ink-faint); font-size: 14px; display: grid; place-content: center; transition: all 0.12s ease; }
.icon-btn:hover { background: rgba(0,0,0,0.05); color: var(--ink); }
.icon-btn.active { color: var(--ink-blue); }
.icon-btn.bookmark.on { color: var(--bookmark); }
.icon-btn.skip:hover { color: var(--danger); background: rgba(168,50,50,0.06); }
.icon-btn.share-btn { font-size: 12px; }
.icon-btn.share-btn.copied { color: var(--success); }

.c-score { margin-left: auto; font-family: var(--serif); font-style: italic; font-size: 12px; color: var(--ink-faint); display: flex; align-items: center; gap: 8px; }
.score-bar { width: 36px; height: 2px; background: var(--paper-edge); border-radius: 1px; overflow: hidden; }
.score-fill { height: 100%; }

/* ── FAB ────────────────────────────────────────────────────────────── */
.fab { position: fixed; bottom: 28px; right: 28px; width: 40px; height: 40px; background: var(--ink); color: var(--paper); border: none; border-radius: 50%; font-size: 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(26,24,20,0.18); display: grid; place-content: center; transition: opacity 0.22s ease, transform 0.12s ease; opacity: 0; pointer-events: none; }
.fab:hover { transform: translateY(-2px); }
.fab.visible { opacity: 1; pointer-events: auto; }

.empty { padding: 24px; color: var(--ink-faint); font-family: var(--serif); font-style: italic; font-size: 14px; text-align: center; border: 1px dashed var(--paper-edge); border-radius: 4px; }

footer { text-align: center; color: var(--ink-faint); font-size: 0.6875rem; padding: 1.5rem 0; font-family: var(--serif); font-style: italic; }

/* ── Dialogs ────────────────────────────────────────────────────────── */
#detail-dialog {
  border: 1px solid var(--border); border-radius: 14px; padding: 0;
  width: 760px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 4rem);
  background: var(--surface); color: var(--text);
  box-shadow: 0 24px 64px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08);
  display: flex; flex-direction: column; margin: auto;
  opacity: 0; transform: scale(0.95) translateY(2%);
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1), display 0.22s allow-discrete, overlay 0.22s allow-discrete;
}
#detail-dialog[open] { opacity: 1; transform: scale(1) translateY(0); }
@starting-style { #detail-dialog[open] { opacity: 0; transform: scale(0.95) translateY(2%); } }
#detail-dialog::backdrop { background: rgba(26,24,20,0.4); backdrop-filter: blur(4px); transition: display 0.22s allow-discrete, overlay 0.22s allow-discrete, background-color 0.2s ease; }
@starting-style { #detail-dialog[open]::backdrop { background-color: transparent; } }
.detail-panel-header { display: flex; align-items: flex-start; gap: 0.75rem; padding: 1rem 1rem 0.75rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-panel-header h2 { flex: 1; font-size: 0.9375rem; font-weight: 600; line-height: 1.5; font-family: var(--serif); color: var(--text); margin: 0; }
.detail-panel-close { flex-shrink: 0; background: none; border: none; color: var(--text-dim); font-size: 1.125rem; cursor: pointer; padding: 0.125rem 0.25rem; line-height: 1; transition: color 0.12s ease; }
.detail-panel-close:hover { color: var(--text); }
.detail-panel-body { flex: 1; overflow-y: auto; padding: 1rem; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.detail-panel-body::-webkit-scrollbar { width: 4px; }
.detail-panel-body::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }
.detail-panel-summary { font-family: var(--serif); font-size: 0.9375rem; color: var(--text-muted); line-height: 1.75; margin: 0 0 1.25rem; padding: 0.75rem 1rem; background: var(--bg); border-radius: 8px; border-left: 3px solid var(--border-light); }
.detail-panel-detail-heading { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); margin: 0 0 0.5rem; }
.detail-panel-detail { font-family: var(--serif); font-size: 0.9375rem; color: var(--text); line-height: 2; white-space: pre-wrap; }
.detail-panel-footer { padding: 0.875rem 1rem; border-top: 1px solid var(--border); flex-shrink: 0; }
.detail-panel-link { display: block; text-align: center; padding: 0.625rem 1rem; background: var(--ink); color: var(--paper); border-radius: 8px; font-family: var(--serif); font-size: 0.875rem; font-weight: 600; text-decoration: none; transition: opacity 0.12s ease; }
.detail-panel-link:hover { opacity: 0.85; }

#settings-dialog { border: 1px solid var(--border); border-radius: 14px; padding: 0; width: 420px; max-width: calc(100vw - 2rem); background: var(--surface); color: var(--text); box-shadow: 0 24px 64px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08); }
#settings-dialog::backdrop { background: rgba(26,24,20,0.4); backdrop-filter: blur(4px); }
.settings-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem 0.75rem; border-bottom: 1px solid var(--border); }
.settings-header h3 { font-size: 0.9375rem; font-weight: 600; font-family: var(--serif); }
.settings-close { background: none; border: none; color: var(--text-dim); font-size: 1.125rem; cursor: pointer; padding: 0.125rem 0.375rem; line-height: 1; transition: color 0.12s ease; }
.settings-close:hover { color: var(--text); }
.settings-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
.settings-field label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-dim); margin-bottom: 0.375rem; text-transform: uppercase; letter-spacing: 0.04em; }
.settings-input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 0.875rem; font-family: monospace; outline: none; transition: border-color 0.12s ease; }
.settings-input:focus { border-color: var(--ink-blue); }
.settings-hint { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem; }
.settings-footer { padding: 0.875rem 1.25rem; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 0.75rem; }
.settings-save { padding: 0.5rem 1.25rem; background: var(--ink); color: var(--paper); border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600; font-family: var(--serif); cursor: pointer; transition: opacity 0.12s ease; flex-shrink: 0; }
.settings-save:hover { opacity: 0.85; }
.sync-indicator { font-size: 0.75rem; color: var(--text-dim); margin-left: auto; }
.sync-indicator.syncing { color: var(--ink-blue); }
.sync-indicator.synced  { color: var(--success); }
.sync-indicator.error   { color: var(--danger); }

/* ── Keyboard shortcut modal ────────────────────────────────────────── */
.kbd-modal-overlay { position: fixed; inset: 0; background: rgba(26,24,20,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(2px); }
.kbd-modal { background: var(--surface); border: 1px solid var(--border-light); border-radius: 12px; padding: 1.5rem 2rem; max-width: 400px; width: 90%; box-shadow: 0 8px 32px rgba(26,24,20,0.15); }
.kbd-modal h3 { font-size: 1rem; font-weight: 600; font-family: var(--serif); margin-bottom: 1rem; }
.kbd-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.kbd-table td { padding: 0.5rem 0.5rem; color: var(--text-muted); vertical-align: middle; }
.kbd-table td:first-child { width: 110px; white-space: nowrap; }
.kbd-table tr + tr td { border-top: 1px solid var(--border); }
kbd { display: inline-block; padding: 0.125rem 0.375rem; border: 1px solid var(--border-light); border-radius: 4px; background: var(--bg); font-size: 0.75rem; font-family: monospace; color: var(--text); line-height: 1.4; }

/* ── Responsive ─────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .app { grid-template-columns: 1fr; }
  .app.expanded { grid-template-columns: 1fr; }
  .rail { position: relative; height: auto; border-right: none; border-bottom: 1px solid var(--rule); flex-direction: row; padding: 8px; overflow: visible; }
  .rail-top { flex-direction: row; padding: 0; overflow: visible; flex: none; }
  .rail-divider, .rail-section-label, .rail-search, .rail-foot { display: none; }
  .masthead-inner { padding: 16px 20px 12px; }
  .wordmark { font-size: 22px; }
  .feed { padding: 20px 20px 60px; }
  .card { padding: 18px 0 20px; margin-left: -4px; }
  .c-title { font-size: 19px; line-height: 1.32; margin-bottom: 8px; }
  .c-summary { font-size: 15px; line-height: 1.6; margin-bottom: 12px; }
  .c-head { font-size: 12px; }
  .feed-avatar { width: 22px; height: 22px; font-size: 10px; }
  .feed-name { font-size: 12px; }
  #detail-dialog { position: fixed; bottom: 0; left: 0; right: 0; top: auto; width: 100%; max-width: 100%; max-height: 88vh; margin: 0; border-radius: 16px 16px 0 0; transform: translateY(100%); transition: opacity 0.2s ease, transform 0.25s cubic-bezier(0.32,0.72,0,1), display 0.25s allow-discrete, overlay 0.25s allow-discrete; }
  #detail-dialog[open] { opacity: 1; transform: translateY(0); }
  @starting-style { #detail-dialog[open] { opacity: 0; transform: translateY(100%); } }
}

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; } }
`.trim();

// ── JavaScript (localStorage ベース、サーバー不要) ────
const JS = `
// ── テーマ管理 ────────────────────────────────────────
function getPreferredTheme() {
  return localStorage.getItem('theme') || 'auto';
}
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}
function cycleTheme() {
  var cur = getPreferredTheme();
  applyTheme(cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto');
}
var themeToggleEl = document.getElementById('theme-toggle');
if (themeToggleEl) themeToggleEl.addEventListener('click', cycleTheme);

// ── 既読 / スキップ状態 (localStorage) ───────────────
var READ_KEY = 'news_read_v2';
var SKIP_KEY = 'news_skip_v2';
var LAST_VISIT_KEY = 'news_last_visit';

function getSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

function restoreState() {
  var readIds = getSet(READ_KEY);
  var skipIds = getSet(SKIP_KEY);
  document.querySelectorAll('.card').forEach(function(card) {
    var id = Number(card.dataset.id);
    if (skipIds.has(id)) {
      card.style.display = 'none';
      return;
    }
    if (readIds.has(id)) {
      card.classList.add('read');
      var btn = card.querySelector('[data-action="read"]');
      if (btn) { btn.classList.add('active'); btn.textContent = '\\u2713'; }
    }
  });
}

function removeNewBadge(card) {
  var badge = card.querySelector('.badge-new');
  if (badge) badge.remove();
}

function toggleRead(card) {
  var id = Number(card.dataset.id);
  var readIds = getSet(READ_KEY);
  var btn = card.querySelector('[data-action="read"]');
  if (card.classList.contains('read')) {
    card.classList.remove('read');
    if (btn) { btn.classList.remove('active'); btn.textContent = ''; }
    readIds.delete(id);
  } else {
    card.classList.add('read');
    if (btn) { btn.classList.add('active'); btn.textContent = '\\u2713'; }
    readIds.add(id);
    removeNewBadge(card);
  }
  saveSet(READ_KEY, readIds);
  scheduleGistSave();
  updateUnreadCount();
  applyFilters();
}

function markRead(card) {
  if (card.classList.contains('read')) return;
  var id = Number(card.dataset.id);
  var readIds = getSet(READ_KEY);
  card.classList.add('read');
  var btn = card.querySelector('[data-action="read"]');
  if (btn) { btn.classList.add('active'); btn.textContent = '\\u2713'; }
  readIds.add(id);
  removeNewBadge(card);
  saveSet(READ_KEY, readIds);
  scheduleGistSave();
  updateUnreadCount();
  applyFilters();
}

function dismissArticle(card) {
  var id = Number(card.dataset.id);
  var skipIds = getSet(SKIP_KEY);
  skipIds.add(id);
  saveSet(SKIP_KEY, skipIds);
  card.style.display = 'none';
  updateSectionVisibility(card.closest('.tier-section'));
  updateUnreadCount();
  updateTocCounts();
}

function markSectionRead(btn) {
  var section = btn.closest('.tier-section');
  var skipIds = getSet(SKIP_KEY);
  var readIds = getSet(READ_KEY);
  section.querySelectorAll('.card:not(.read)').forEach(function(card) {
    if (card.style.display === 'none') return;
    var id = Number(card.dataset.id);
    card.classList.add('read');
    var rb = card.querySelector('[data-action="read"]');
    if (rb) { rb.classList.add('active'); rb.textContent = '\\u2713'; }
    readIds.add(id);
  });
  saveSet(READ_KEY, readIds);
  scheduleGistSave();
  updateUnreadCount();
  applyFilters();
}

function skipSectionAll(btn) {
  var section = btn.closest('.tier-section');
  var skipIds = getSet(SKIP_KEY);
  section.querySelectorAll('.card').forEach(function(card) {
    if (card.style.display === 'none') return;
    skipIds.add(Number(card.dataset.id));
    card.style.display = 'none';
  });
  saveSet(SKIP_KEY, skipIds);
  updateSectionVisibility(section);
  updateUnreadCount();
  updateTocCounts();
}

// ── 統計更新 ──────────────────────────────────────────
function updateUnreadCount() {
  var unread = document.querySelectorAll('.card:not(.read):not([style*="display: none"])').length;
  var el = document.getElementById('unread-count');
  if (el) el.textContent = String(unread);
}

function updateTocCounts() {
  document.querySelectorAll('.toc-link').forEach(function(link) {
    var href = link.getAttribute('href');
    if (!href) return;
    var sectionId = href.slice(1);
    var section = document.getElementById(sectionId);
    var countEl = link.querySelector('.rail-count');
    if (section && countEl) {
      var visible = section.querySelectorAll('.card:not([style*="display: none"])').length;
      countEl.textContent = String(visible);
      link.style.display = visible ? '' : 'none';
    }
  });
}

function updateSectionVisibility(section) {
  if (!section) return;
  var visible = section.querySelectorAll('.card:not([style*="display: none"])').length;
  section.style.display = visible ? '' : 'none';
}

// ── フィルター ────────────────────────────────────────
var params = new URLSearchParams(location.search);
var currentReadFilter = params.get('read') || 'all';
var currentCategoryFilter = params.get('category') || 'all';
var currentDateFilter = params.get('date') || 'all';
var currentSourceFilter = params.get('source') || 'all';
var currentBookmarkFilter = false;
var currentSearch = '';

function updateURL() {
  var p = new URLSearchParams(location.search);
  currentReadFilter === 'all' ? p.delete('read') : p.set('read', currentReadFilter);
  currentCategoryFilter === 'all' ? p.delete('category') : p.set('category', currentCategoryFilter);
  currentDateFilter === 'all' ? p.delete('date') : p.set('date', currentDateFilter);
  currentSourceFilter === 'all' ? p.delete('source') : p.set('source', currentSourceFilter);
  var qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function applyFilters() {
  var q = currentSearch.toLowerCase();
  document.querySelectorAll('.card').forEach(function(card) {
    var isRead = card.classList.contains('read');
    var cat = card.dataset.category || '';
    var title = (card.querySelector('.c-title') || {}).textContent || '';
    var summary = (card.querySelector('.c-summary') || {}).textContent || '';
    var show = true;
    if (currentReadFilter === 'unread' && isRead) show = false;
    if (currentReadFilter === 'read' && !isRead) show = false;
    if (currentCategoryFilter !== 'all' && cat !== currentCategoryFilter) show = false;
    if (currentSourceFilter !== 'all') {
      var feedEl = card.querySelector('.feed-name');
      var src = feedEl ? feedEl.textContent.trim() : '';
      if (src !== currentSourceFilter) show = false;
    }
    if (currentDateFilter !== 'all') {
      var dateStr = card.dataset.date;
      if (dateStr) {
        var cardDate = new Date(dateStr);
        var now = new Date();
        var cutoff;
        if (currentDateFilter === 'today') {
          cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else if (currentDateFilter === '3days') {
          cutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        } else if (currentDateFilter === 'week') {
          cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }
        if (cutoff && cardDate < cutoff) show = false;
      }
    }
    if (currentBookmarkFilter) {
      var cardLink = card.querySelector('.c-title a');
      if (!cardLink || !isBookmarked(cardLink.href)) show = false;
    }
    if (q && !title.toLowerCase().includes(q) && !summary.toLowerCase().includes(q)) show = false;
    if (show && card.style.display === 'none' && getSet(SKIP_KEY).has(Number(card.dataset.id))) show = false;
    if (show) card.style.display = '';
    else if (!getSet(SKIP_KEY).has(Number(card.dataset.id))) card.style.display = show ? '' : 'none';
  });
  document.querySelectorAll('.tier-section').forEach(function(sec) {
    var visible = sec.querySelectorAll('.card:not([style*="display: none"])').length;
    sec.style.display = visible ? '' : 'none';
  });
  var totalVisible = document.querySelectorAll('.card:not([style*="display: none"])').length;
  var emptyEl = document.getElementById('no-results');
  if (emptyEl) emptyEl.style.display = totalVisible ? 'none' : 'block';
  updateTocCounts();
  updateURL();
}

function setActiveBtn(containerId, value) {
  document.querySelectorAll('#' + containerId + ' .filter-btn').forEach(function(b) {
    b.classList.toggle('active', (b.dataset.value || 'all') === value);
  });
}

function filterArticles(mode) {
  currentReadFilter = mode;
  setActiveBtn('read-filters', mode);
  applyFilters();
}

function filterByCategory(cat) {
  currentCategoryFilter = cat;
  setActiveBtn('category-chips', cat);
  applyFilters();
}

function filterByDate(period) {
  currentDateFilter = period;
  setActiveBtn('date-filters', period);
  applyFilters();
}

function filterBySource(source) {
  currentSourceFilter = source;
  setActiveBtn('source-filters', source);
  applyFilters();
}

function buildSourceFilters() {
  var container = document.getElementById('source-filters');
  if (!container) return;
  var sources = [];
  var seen = new Set();
  document.querySelectorAll('.card .feed-name').forEach(function(el) {
    var s = el.textContent.trim();
    if (s && !seen.has(s)) { seen.add(s); sources.push(s); }
  });
  sources.sort();
  sources.forEach(function(source) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-icon filter-btn';
    btn.dataset.value = source;
    btn.textContent = source;
    container.appendChild(btn);
  });
}

// ── イベント委譲 ──────────────────────────────────────
document.querySelector('main').addEventListener('click', function(e) {
  var readBtn = e.target.closest('[data-action="read"]');
  if (readBtn) { toggleRead(readBtn.closest('.card')); return; }

  var skipBtn = e.target.closest('[data-action="skip"]');
  if (skipBtn) { dismissArticle(skipBtn.closest('.card')); return; }

  var bmBtn = e.target.closest('[data-action="bookmark"]');
  if (bmBtn) {
    var bmCard = bmBtn.closest('.card');
    if (!bmCard) return;
    var bmLink = bmCard.querySelector('.c-title a');
    if (!bmLink) return;
    var nowBm = toggleBookmark(bmLink.href);
    bmBtn.textContent = nowBm ? '★' : '☆';
    bmBtn.classList.toggle('on', nowBm);
    return;
  }

  var markBtn = e.target.closest('.mark-section-read');
  if (markBtn) { markSectionRead(markBtn); return; }

  var skipSecBtn = e.target.closest('.skip-section-btn');
  if (skipSecBtn) { skipSectionAll(skipSecBtn); return; }

  var shareBtn = e.target.closest('[data-action="share"]');
  if (shareBtn) { shareArticle(shareBtn); return; }

  var articleLink = e.target.closest('.c-title a');
  if (articleLink) { markRead(articleLink.closest('.card')); return; }

  var card = e.target.closest('.card.has-detail');
  if (card && !e.target.closest('[data-action], .c-score')) {
    openDetailPanel(card);
  }
});

// ── 詳細パネル（ネイティブ dialog） ──────────────────
var detailDialog = document.getElementById('detail-dialog');

function openDetailPanel(card) {
  document.getElementById('detail-panel-title').textContent = card.dataset.title || '';
  document.getElementById('detail-panel-summary').textContent = card.dataset.summary || '';
  document.getElementById('detail-panel-detail').textContent = card.dataset.detail || '';
  document.getElementById('detail-panel-link').href = card.dataset.url || '#';
  detailDialog.showModal();
}

function closeDetailPanel() {
  detailDialog.close();
}

document.getElementById('detail-panel-close').addEventListener('click', closeDetailPanel);
detailDialog.addEventListener('click', function(e) {
  // backdrop クリックで閉じる（dialog 要素外クリック）
  var rect = detailDialog.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    closeDetailPanel();
  }
});

document.getElementById('category-chips').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterByCategory(btn.dataset.value || 'all');
});

document.getElementById('read-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterArticles(btn.dataset.value || 'all');
});

document.getElementById('date-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterByDate(btn.dataset.value || 'all');
});

document.getElementById('source-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterBySource(btn.dataset.value || 'all');
});

document.getElementById('bookmark-filter-btn').addEventListener('click', function() {
  currentBookmarkFilter = !currentBookmarkFilter;
  this.classList.toggle('active', currentBookmarkFilter);
  applyFilters();
});

var searchEl = document.getElementById('search');
var searchTimer = null;
searchEl.addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() {
    currentSearch = searchEl.value.trim();
    applyFilters();
  }, 300);
});

// ── モバイル フィルタートグル ─────────────────────────

// ── ブックマーク機能 ──────────────────────────────────
var BOOKMARK_KEY = 'bookmarks';

function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '[]'); } catch (e) { return []; }
}
function saveBookmarks(arr) { localStorage.setItem(BOOKMARK_KEY, JSON.stringify(arr)); }
function isBookmarked(url) { return getBookmarks().indexOf(url) !== -1; }
function toggleBookmark(url) {
  var bms = getBookmarks();
  var idx = bms.indexOf(url);
  if (idx === -1) bms.push(url); else bms.splice(idx, 1);
  saveBookmarks(bms);
  scheduleGistSave();
  return idx === -1;
}

// ── Gist 同期 ────────────────────────────────────────
var GIST_PAT_KEY = 'gist_pat';
var GIST_ID_KEY  = 'gist_id';
var GIST_FILE    = 'news-digest-sync.json';
var gistSaveTimer = null;

function getGistConfig() {
  return { pat: localStorage.getItem(GIST_PAT_KEY) || '', id: localStorage.getItem(GIST_ID_KEY) || '' };
}

function setSyncStatus(status, msg) {
  var el = document.getElementById('sync-indicator');
  if (el) {
    el.className = 'sync-indicator' + (status ? ' ' + status : '');
    el.textContent = msg;
  }
  var dot = document.getElementById('sync-dot');
  if (!dot) return;
  var dotClass = status === 'synced' ? 'ok' : status === 'syncing' ? 'syncing' : status === 'error' ? 'error' : '';
  dot.className = 'sync-dot' + (dotClass ? ' ' + dotClass : '');
  var tooltips = { synced: '同期済み', syncing: '同期中...', error: '同期エラー — ⚙ を確認' };
  dot.title = tooltips[status] || '';
}

function initSyncDot() {
  var cfg = getGistConfig();
  var dot = document.getElementById('sync-dot');
  if (!dot) return;
  if (!cfg.pat || !cfg.id) {
    dot.className = 'sync-dot error';
    dot.title = '同期未設定 — ⚙ をクリックして設定';
    document.getElementById('settings-btn').title = '同期未設定 — クリックして設定';
  }
}

async function loadFromGist() {
  var cfg = getGistConfig();
  if (!cfg.pat || !cfg.id) return;
  try {
    setSyncStatus('syncing', '同期中...');
    var res = await fetch('https://api.github.com/gists/' + cfg.id, {
      headers: { Authorization: 'Bearer ' + cfg.pat, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) { setSyncStatus('error', '同期エラー'); return; }
    var data = await res.json();
    var file = data.files && data.files[GIST_FILE];
    if (!file || !file.content) { setSyncStatus('synced', '同期済'); return; }
    var remote = JSON.parse(file.content);
    if (Array.isArray(remote.read)) {
      var readIds = getSet(READ_KEY);
      remote.read.forEach(function(id) { readIds.add(Number(id)); });
      saveSet(READ_KEY, readIds);
    }
    if (Array.isArray(remote.bookmarks)) {
      var bms = getBookmarks();
      var bmsSet = new Set(bms);
      remote.bookmarks.forEach(function(url) { bmsSet.add(url); });
      saveBookmarks(Array.from(bmsSet));
    }
    restoreState();
    restoreBookmarkState();
    setSyncStatus('synced', '同期済');
  } catch(e) {
    setSyncStatus('error', 'オフライン');
  }
}

async function saveToGist() {
  var cfg = getGistConfig();
  if (!cfg.pat || !cfg.id) return;
  try {
    setSyncStatus('syncing', '保存中...');
    var files = {};
    files[GIST_FILE] = { content: JSON.stringify({ read: Array.from(getSet(READ_KEY)), bookmarks: getBookmarks() }) };
    var res = await fetch('https://api.github.com/gists/' + cfg.id, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + cfg.pat, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files })
    });
    setSyncStatus(res.ok ? 'synced' : 'error', res.ok ? '同期済' : '同期エラー');
  } catch(e) {
    setSyncStatus('error', 'オフライン');
  }
}

function scheduleGistSave() {
  if (gistSaveTimer) clearTimeout(gistSaveTimer);
  gistSaveTimer = setTimeout(saveToGist, 800);
}

function restoreBookmarkState() {
  document.querySelectorAll('.card').forEach(function(card) {
    var link = card.querySelector('.c-title a');
    var bBtn = card.querySelector('[data-action="bookmark"]');
    if (!link || !bBtn) return;
    var bookmarked = isBookmarked(link.href);
    bBtn.classList.toggle('on', bookmarked);
    bBtn.textContent = bookmarked ? '\\u2605' : '\\u2606';
  });
  applyFilters();
}


function exportBookmarks() {
  var bms = getBookmarks();
  if (bms.length === 0) { alert('ブックマークがありません'); return; }
  var today = new Date().toISOString().slice(0, 10);
  var lines = ['# Bookmarks - ' + today, ''];
  bms.forEach(function(url) {
    var title = url;
    document.querySelectorAll('.c-title a').forEach(function(a) {
      if (a.href === url) title = a.textContent.trim();
    });
    lines.push('- [' + title.replace(/\\[/g, '\\\\[').replace(/\\]/g, '\\\\]') + '](' + url.replace(/\\(/g, '%28').replace(/\\)/g, '%29') + ')');
  });
  var blob = new Blob([lines.join('\\n') + '\\n'], { type: 'text/markdown; charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bookmarks-' + today + '.md';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
var exportBtnEl = document.getElementById('export-bookmarks-btn');
if (exportBtnEl) exportBtnEl.addEventListener('click', exportBookmarks);

// ── SNSシェア ─────────────────────────────────────────

function shareArticle(btn) {
  var text = (btn.dataset.shareTitle || '') + ' ' + (btn.dataset.shareUrl || '') + ' #NewsDigest';
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = '\u2713 Copied for X';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Share'; btn.classList.remove('copied'); }, 1000);
  });
}



// ── キーボードショートカット ──────────────────────────
var focusedCard = null;
var kbdModal = null;

function getVisibleCards() {
  return Array.from(document.querySelectorAll('.card:not([style*="display: none"])'));
}
function setFocus(card) {
  if (focusedCard) focusedCard.classList.remove('focused');
  focusedCard = card;
  if (card) { card.classList.add('focused'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
function moveFocus(dir) {
  var cards = getVisibleCards();
  if (!cards.length) return;
  var idx = focusedCard ? cards.indexOf(focusedCard) : -1;
  var next = idx === -1 ? (dir === 1 ? 0 : cards.length - 1) : (dir === 1 ? Math.min(idx + 1, cards.length - 1) : Math.max(idx - 1, 0));
  setFocus(cards[next]);
}
function showKbdModal() {
  if (kbdModal) { kbdModal.remove(); kbdModal = null; return; }
  var overlay = document.createElement('div');
  overlay.className = 'kbd-modal-overlay';
  overlay.innerHTML = '<div class="kbd-modal"><h3>キーボードショートカット</h3><table class="kbd-table">' +
    '<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>次/前の記事へ移動</td></tr>' +
    '<tr><td><kbd>r</kbd></td><td>既読トグル</td></tr>' +
    '<tr><td><kbd>b</kbd></td><td>ブックマークトグル</td></tr>' +
    '<tr><td><kbd>?</kbd></td><td>このヘルプを表示</td></tr>' +
    '<tr><td><kbd>Esc</kbd></td><td>モーダルを閉じる</td></tr>' +
    '</table></div>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) { overlay.remove(); kbdModal = null; } });
  document.body.appendChild(overlay);
  kbdModal = overlay;
}
document.addEventListener('keydown', function(e) {
  var tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (detailDialog && detailDialog.open) return;
  switch (e.key) {
    case 'j': moveFocus(1); e.preventDefault(); break;
    case 'k': moveFocus(-1); e.preventDefault(); break;
    case 'r': if (focusedCard) toggleRead(focusedCard); break;
    case 'b':
      if (focusedCard) {
        var bLink = focusedCard.querySelector('.c-title a');
        var bBtn = focusedCard.querySelector('[data-action="bookmark"]');
        if (bLink && bBtn) {
          var nowBm = toggleBookmark(bLink.href);
          bBtn.textContent = nowBm ? '\u2605' : '\u2606';
          bBtn.classList.toggle('on', nowBm);
        }
      }
      break;
    case '?': showKbdModal(); e.preventDefault(); break;
    case 'Escape': if (kbdModal) { kbdModal.remove(); kbdModal = null; } break;
  }
});

// ── トップへ戻る ──────────────────────────────────────
var backToTopBtn = document.getElementById('back-to-top');
window.addEventListener('scroll', function() {
  backToTopBtn.classList.toggle('visible', window.scrollY > 400);
}, { passive: true });
backToTopBtn.addEventListener('click', function() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── 設定モーダル ──────────────────────────────────────
(function() {
  var settingsBtn    = document.getElementById('settings-btn');
  var settingsDialog = document.getElementById('settings-dialog');
  var settingsClose  = document.getElementById('settings-close');
  var settingsSave   = document.getElementById('settings-save');
  var patInput       = document.getElementById('settings-pat');
  var gistIdInput    = document.getElementById('settings-gist-id');

  settingsBtn.addEventListener('click', function() {
    var cfg = getGistConfig();
    patInput.value    = cfg.pat;
    gistIdInput.value = cfg.id;
    settingsDialog.showModal();
  });
  settingsClose.addEventListener('click', function() { settingsDialog.close(); });
  settingsDialog.addEventListener('click', function(e) {
    if (e.target === settingsDialog) settingsDialog.close();
  });
  settingsSave.addEventListener('click', function() {
    var pat    = patInput.value.trim();
    var gistId = gistIdInput.value.trim();
    localStorage.setItem(GIST_PAT_KEY, pat);
    localStorage.setItem(GIST_ID_KEY, gistId);
    settingsDialog.close();
    if (pat && gistId) loadFromGist();
  });
})();

// ── 初期化 ────────────────────────────────────────────
// ── 新着バッジ ────────────────────────────────────────
function applyNewBadges() {
  var lastVisit = localStorage.getItem(LAST_VISIT_KEY);
  if (!lastVisit) return; // 初回訪問はバッジなし
  var readIds = getSet(READ_KEY);
  document.querySelectorAll('.card').forEach(function(card) {
    var pubDate = card.dataset.date;
    if (!pubDate || card.querySelector('.badge-new')) return;
    if (pubDate > lastVisit && !readIds.has(Number(card.dataset.id))) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = 'NEW';
      var meta = card.querySelector('.c-head');
      if (meta) meta.append(badge);
    }
  });
  // 今回の訪問時刻を記録（次回のために）
  localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
}

restoreState();
buildSourceFilters();
setActiveBtn('read-filters', currentReadFilter);
setActiveBtn('category-chips', currentCategoryFilter);
setActiveBtn('date-filters', currentDateFilter);
setActiveBtn('source-filters', currentSourceFilter);
applyFilters();
initSyncDot();
applyNewBadges();
loadFromGist();

// ── レール展開/折り畳み ────────────────────────────────
var appEl = document.getElementById('app');
var railToggleEl = document.getElementById('rail-toggle');
if (railToggleEl && appEl) {
  railToggleEl.addEventListener('click', function() {
    appEl.classList.toggle('expanded');
  });
}
`.trim();

// ── メイン生成関数 ────────────────────────────────────
export async function generateHtml(
  _db: Database,
  q: Queries,
  rootDir: string
): Promise<void> {
  const rows = q.selectDigestArticles.all() as DigestArticleRow[];

  // ティア別グルーピング
  const tierMap = new Map<string, DigestArticleRow[]>();
  for (const t of TIERS) tierMap.set(t.id, []);
  for (const row of rows) {
    const score = typeof row.personal_score === "number" ? row.personal_score : 0;
    // X ブックマークは手動選択のため常に Must Read
    const tier = row.source_id === "x" ? TIERS[0]! : getTier(score);
    tierMap.get(tier.id)!.push(row);
  }

  // カテゴリ一覧（重複排除・出現順）
  const categories = [...new Set(rows.map((a) => a.category))];

  // 日付表示
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const updatedAt = new Date().toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // レール TOC アイテム
  const TIER_GLYPHS: Record<string, string> = {
    "must-read": "★", "recommended": "◆", "worth-a-look": "●", "low-priority": "○",
  };
  const tocItems = TIERS.filter((t) => (tierMap.get(t.id)?.length ?? 0) > 0)
    .map(
      (t) => `<a class="rail-icon toc-link" href="#${t.id}" style="color:${t.color}">
        <span class="rail-glyph">${TIER_GLYPHS[t.id] ?? "·"}</span>
        <span class="rail-label" style="color:var(--ink)">${t.label}</span>
        <span class="rail-count">${tierMap.get(t.id)!.length}</span>
      </a>`
    )
    .join("\n");

  // カテゴリ chip ボタン（マストヘッド）
  const catButtons = ["all", ...categories]
    .map((c) => {
      const label = c === "all" ? "すべて" : categoryLabel(c);
      const cls = c === "all" ? "chip filter-btn active" : "chip filter-btn";
      return `<button type="button" class="${cls}" data-value="${esc(c)}">${esc(label)}</button>`;
    })
    .join("\n");

  // ティアセクション
  const sections = TIERS.filter((t) => (tierMap.get(t.id)?.length ?? 0) > 0)
    .map((t) => tierSectionHtml(t, tierMap.get(t.id)!))
    .join("\n\n");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src https: data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://api.github.com">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="https://github.com/viserhaut.png">
<title>News Digest</title>
<style>${CSS}</style>
<script>
  (function(){
    var t = localStorage.getItem('theme');
    if (t && t !== 'auto') document.documentElement.setAttribute('data-theme', t);
  })();
</script>
</head>
<body>
<div class="app" id="app">

<nav class="rail">
  <div class="rail-top">
    <div class="rail-mark" id="rail-toggle">N</div>

    <div class="rail-section-label">Sections</div>
    ${tocItems}

    <div class="rail-divider"></div>
    <div class="rail-section-label">表示</div>
    <div id="read-filters">
      <button type="button" class="rail-icon filter-btn active" data-value="all">
        <span class="rail-glyph">≡</span>
        <span class="rail-label">すべて</span>
      </button>
      <button type="button" class="rail-icon filter-btn" data-value="unread">
        <span class="rail-glyph">○</span>
        <span class="rail-label">未読のみ</span>
        <span class="rail-count" id="unread-count">${rows.length}</span>
      </button>
      <button type="button" class="rail-icon filter-btn" data-value="read">
        <span class="rail-glyph">✓</span>
        <span class="rail-label">既読のみ</span>
      </button>
    </div>

    <div class="rail-divider"></div>
    <div class="rail-section-label">期間</div>
    <div id="date-filters">
      <button type="button" class="rail-icon filter-btn active" data-value="all">
        <span class="rail-glyph">◷</span>
        <span class="rail-label">すべて</span>
      </button>
      <button type="button" class="rail-icon filter-btn" data-value="today">
        <span class="rail-glyph">◈</span>
        <span class="rail-label">今日</span>
      </button>
      <button type="button" class="rail-icon filter-btn" data-value="3days">
        <span class="rail-glyph">◉</span>
        <span class="rail-label">3日間</span>
      </button>
      <button type="button" class="rail-icon filter-btn" data-value="week">
        <span class="rail-glyph">◎</span>
        <span class="rail-label">1週間</span>
      </button>
    </div>

    <div class="rail-divider"></div>
    <div class="rail-section-label">ソース</div>
    <div id="source-filters">
      <button type="button" class="rail-icon filter-btn active" data-value="all">
        <span class="rail-glyph">⊞</span>
        <span class="rail-label">すべて</span>
      </button>
    </div>
    <input type="search" class="rail-search" id="search" placeholder="キーワード検索…" aria-label="記事を検索">

    <div class="rail-divider"></div>
    <button type="button" class="rail-icon filter-btn" id="bookmark-filter-btn" data-value="bookmarked">
      <span class="rail-glyph">★</span>
      <span class="rail-label">ブックマーク</span>
    </button>
    <button type="button" class="export-btn" id="export-bookmarks-btn">📥 書き出す</button>
    <div class="rail-divider"></div>
    <div class="settings-btn-wrap">
      <button type="button" class="rail-icon" id="settings-btn" title="同期設定">
        <span class="rail-glyph">⚙</span>
        <span class="rail-label">同期設定</span>
      </button>
      <span class="sync-dot" id="sync-dot"></span>
    </div>
  </div>
  <div class="rail-foot">
    <div class="rail-foot-text">News Digest · ${today}</div>
  </div>
</nav>

<main>
  <div class="masthead">
    <div class="masthead-inner">
      <div class="brand-row">
        <span class="wordmark">News <span class="ampersand">&amp;</span> Digest</span>
        <span class="masthead-date">${today}</span>
      </div>
      <div class="masthead-rule"></div>
      <div class="chips" id="category-chips">
        ${catButtons}
      </div>
    </div>
  </div>

  <div class="feed">
    ${sections}

    <div id="no-results" class="empty" style="display:none">
      条件に一致する記事はありません。フィルターを変えてみてください。
    </div>

    <footer>更新: ${updatedAt}</footer>
  </div>
</main>

</div>

<!-- トップへ戻るボタン -->
<button type="button" class="fab" id="back-to-top" aria-label="トップへ戻る">↑</button>

<!-- 同期設定モーダル -->
<dialog id="settings-dialog" aria-labelledby="settings-dialog-title">
  <div class="settings-header">
    <h3 id="settings-dialog-title">同期設定（GitHub Gist）</h3>
    <button type="button" class="settings-close" id="settings-close" aria-label="閉じる">&#x2715;</button>
  </div>
  <div class="settings-body">
    <div class="settings-field">
      <label for="settings-pat">GitHub Fine-grained PAT</label>
      <input type="password" id="settings-pat" class="settings-input" placeholder="github_pat_xxxx..." autocomplete="off">
      <p class="settings-hint">Gist の read/write 権限のみ付与してください</p>
    </div>
    <div class="settings-field">
      <label for="settings-gist-id">Gist ID</label>
      <input type="text" id="settings-gist-id" class="settings-input" placeholder="abc123def456..." autocomplete="off">
      <p class="settings-hint">プライベート Gist の ID（URLの末尾の文字列）</p>
    </div>
  </div>
  <div class="settings-footer">
    <button type="button" class="settings-save" id="settings-save">保存して同期</button>
    <span class="sync-indicator" id="sync-indicator"></span>
  </div>
</dialog>

<!-- 詳細パネル（ネイティブ dialog） -->
<dialog id="detail-dialog" aria-labelledby="detail-panel-title">
  <div class="detail-panel-header">
    <h2 id="detail-panel-title"></h2>
    <button type="button" class="detail-panel-close" id="detail-panel-close" aria-label="閉じる">✕</button>
  </div>
  <div class="detail-panel-body">
    <p class="detail-panel-summary" id="detail-panel-summary"></p>
    <p class="detail-panel-detail-heading">詳細サマリー</p>
    <div class="detail-panel-detail" id="detail-panel-detail"></div>
  </div>
  <div class="detail-panel-footer">
    <a class="detail-panel-link" id="detail-panel-link" href="#" target="_blank" rel="noopener noreferrer">元記事を読む →</a>
  </div>
</dialog>

<script>
${JS}
</script>
</body>
</html>`;

  const docsDir = join(rootDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "index.html"), html, "utf-8");
}

// ── スタンドアロン実行 ────────────────────────────────
if (import.meta.main) {
  const ROOT_DIR = join(import.meta.dir, "../..");
  const DB_PATH = process.env.DB_PATH ?? join(ROOT_DIR, "data", "digest.db");
  const db = initDb(DB_PATH);
  const q = makeQueries(db);
  await generateHtml(db, q, ROOT_DIR);
  db.close();
  console.log("[done] docs/index.html generated");
}
