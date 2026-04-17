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
  { id: "must-read",    label: "Must Read",    color: "#10b981", min: 0.85 },
  { id: "recommended",  label: "Recommended",  color: "#3b82f6", min: 0.70 },
  { id: "worth-a-look", label: "Worth a Look", color: "#f59e0b", min: 0.50 },
  { id: "low-priority", label: "Low Priority", color: "#6b7280", min: 0.00 },
] as const;

type Tier = (typeof TIERS)[number];

function getTier(score: number): Tier {
  for (const t of TIERS) {
    if (score >= t.min) return t;
  }
  return TIERS[TIERS.length - 1]!;
}

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

  return `<article class="card${a.detail_summary_ja ? " has-detail" : ""}" data-id="${a.id}" data-category="${esc(a.category)}" data-tier="${tier.id}" data-date="${esc(a.published_at ?? "")}"${a.detail_summary_ja ? ` data-detail="${esc(a.detail_summary_ja)}" data-url="${safeUrl(a.url)}" data-title="${esc(a.title_ja ?? a.url)}" data-summary="${esc(a.summary_ja ?? "")}"` : ""}>
  <button type="button" class="skip-btn" aria-label="スキップ">✕</button>
  <div class="card-row">
    <button type="button" class="read-btn" aria-label="既読にする"></button>
    <div class="card-body">
      <h3 class="card-title"><a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title_ja ?? a.url)}</a></h3>
      ${summaryHtml(a.summary_ja)}
      <div class="card-meta">
        <span class="feed-name">${esc(a.source_id)}</span>
        <span class="sep">·</span>
        <span class="date">${formatDate(a.published_at)}</span>
        <span class="tag">${esc(categoryLabel(a.category))}</span>
      </div>
    </div>
    <div class="card-score">
      <div class="score-ring" style="--pct:${scorePct};--color:${tier.color}">
        <span>${scorePct}</span>
      </div>
    </div>
  </div>
</article>`;
}

// ── ティアセクション HTML ─────────────────────────────
function tierSectionHtml(tier: Tier, cards: DigestArticleRow[]): string {
  const cardsHtml = cards.map(cardHtml).join("\n");
  return `<section id="${tier.id}" class="tier-section">
  <div class="tier-header">
    <span class="tier-bar" style="background:${tier.color}"></span>
    <h2>${tier.label}</h2>
    <span class="tier-count">${cards.length}</span>
    <button type="button" class="mark-section-read">全て既読</button>
    <button type="button" class="skip-section-btn">スキップ</button>
  </div>
  ${cardsHtml}
</section>`;
}

// ── CSS (Feed Curator ベース) ─────────────────────────
const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root { --sidebar-w: 220px; }

:root, [data-theme="dark"] {
  --bg: #09090b; --surface: #18181b; --surface-hover: #1e1e22;
  --border: #27272a; --border-light: #3f3f46;
  --text: #fafafa; --text-muted: #a1a1aa; --text-dim: #71717a;
  --accent: #7c3aed; --accent-light: #a78bfa;
  --accent-glow: rgba(167,139,250,0.12);
  --tag-bg: rgba(167,139,250,0.12); --tag-text: #a78bfa; --logo-from: #fff;
}

[data-theme="light"] {
  --bg: #fafafa; --surface: #ffffff; --surface-hover: #f4f4f5;
  --border: #e4e4e7; --border-light: #d4d4d8;
  --text: #18181b; --text-muted: #52525b; --text-dim: #71717a;
  --accent: #7c3aed; --accent-light: #7c3aed;
  --accent-glow: rgba(124,58,237,0.08);
  --tag-bg: rgba(124,58,237,0.08); --tag-text: #6d28d9; --logo-from: #18181b;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg: #fafafa; --surface: #ffffff; --surface-hover: #f4f4f5;
    --border: #e4e4e7; --border-light: #d4d4d8;
    --text: #18181b; --text-muted: #52525b; --text-dim: #71717a;
    --accent: #7c3aed; --accent-light: #7c3aed;
    --accent-glow: rgba(124,58,237,0.08);
    --tag-bg: rgba(124,58,237,0.08); --tag-text: #6d28d9; --logo-from: #18181b;
  }
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh;
}

.layout { display: flex; max-width: 1080px; margin: 0 auto; min-height: 100vh; }

.sidebar {
  width: var(--sidebar-w); flex-shrink: 0; padding: 2rem 1.25rem;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  border-right: 1px solid var(--border);
}

.main { flex: 1; min-width: 0; padding: 2rem 2rem 4rem; }

.logo {
  font-size: 1.125rem; font-weight: 700; letter-spacing: -0.03em;
  background: linear-gradient(135deg, var(--logo-from) 0%, var(--accent-light) 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;
}

.logo-icon {
  width: 1.5rem; height: 1.5rem; flex-shrink: 0;
  -webkit-text-fill-color: initial; color: var(--accent-light);
}

.date-label { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 1.5rem; }

.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 1.5rem; }

.stat-box { background: var(--surface); border-radius: 8px; padding: 0.625rem 0.75rem; }
.stat-val { font-size: 1.25rem; font-weight: 700; }
.stat-lbl { font-size: 0.6875rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }

.sidebar-section { margin-bottom: 1.5rem; }

.sidebar-heading {
  font-size: 0.6875rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem;
}

.filter-list { display: flex; flex-direction: column; gap: 0.25rem; }

.filter-btn {
  background: none; border: none; border-radius: 6px; padding: 0.4rem 0.625rem;
  color: var(--text-muted); font-size: 0.8125rem; cursor: pointer;
  text-align: left; transition: all 0.12s ease;
}
.filter-btn:hover { background: var(--surface); color: var(--text); }
.filter-btn.active { background: var(--accent-glow); color: var(--accent); font-weight: 600; }

.toc-link {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.375rem 0.625rem;
  border-radius: 6px; color: var(--text-muted); text-decoration: none;
  font-size: 0.8125rem; transition: all 0.12s ease;
}
.toc-link:hover { background: var(--surface); color: var(--text); }

.toc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.toc-count { margin-left: auto; font-size: 0.75rem; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.sidebar-top { display: flex; align-items: center; justify-content: space-between; }

.theme-toggle {
  background: none; border: 1px solid var(--border); border-radius: 6px;
  width: 2rem; height: 2rem; cursor: pointer; display: flex; align-items: center;
  justify-content: center; transition: all 0.15s ease; color: var(--text-dim); font-size: 1rem;
}
.theme-toggle:hover { border-color: var(--accent-light); color: var(--accent-light); }

.theme-icon::before { content: "\\25D0"; }
[data-theme="dark"] .theme-icon::before { content: "\\2600"; }
[data-theme="light"] .theme-icon::before { content: "\\263E"; }

.tier-section { margin-bottom: 2.5rem; }

.tier-header {
  display: flex; align-items: center; gap: 0.625rem;
  margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}
.tier-bar { width: 3px; height: 1.25rem; border-radius: 2px; }
.tier-header h2 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; }
.tier-count {
  font-size: 0.75rem; color: var(--text-dim); background: var(--surface);
  padding: 0.125rem 0.5rem; border-radius: 999px;
}

.mark-section-read {
  margin-left: auto; background: none; border: 1px solid var(--border); border-radius: 6px;
  padding: 0.25rem 0.625rem; color: var(--text-dim); font-size: 0.6875rem;
  cursor: pointer; transition: all 0.12s ease;
}
.mark-section-read:hover { border-color: var(--accent-light); color: var(--accent-light); }

.skip-section-btn {
  background: none; border: 1px solid var(--border); border-radius: 6px;
  padding: 0.25rem 0.625rem; color: var(--text-dim); font-size: 0.6875rem;
  cursor: pointer; transition: all 0.12s ease;
}
.skip-section-btn:hover { border-color: #ef4444; color: #ef4444; }

.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 1rem 1.25rem; margin-bottom: 0.5rem;
  transition: background 0.15s ease, border-color 0.15s ease;
  position: relative;
}
.card:hover { background: var(--surface-hover); border-color: var(--border-light); }
.card.read { opacity: 0.45; }
.card.read:hover { opacity: 0.75; }

.card-row { display: flex; align-items: flex-start; gap: 0.875rem; }

.read-btn {
  flex-shrink: 0; width: 1.375rem; height: 1.375rem; margin-top: 0.125rem;
  background: none; border: 1.5px solid var(--border-light); border-radius: 4px;
  cursor: pointer; color: var(--text-dim); font-size: 0.75rem;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.12s ease; padding: 0;
}
.read-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
.read-btn.is-read { background: var(--accent); border-color: var(--accent); color: #fff; }

.skip-btn {
  position: absolute; top: 0.5rem; right: 0.5rem;
  width: 1.25rem; height: 1.25rem;
  background: var(--surface); border: 1px solid var(--border-light); border-radius: 50%;
  cursor: pointer; color: var(--text-dim); font-size: 0.625rem;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.12s ease, border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
  padding: 0; z-index: 1;
}
.card:hover .skip-btn { opacity: 1; }
.skip-btn:hover { border-color: #ef4444; color: #ef4444; background: rgba(239,68,68,0.1); }

.card-body { flex: 1; min-width: 0; }

.card-title { font-size: 0.9375rem; font-weight: 600; line-height: 1.4; margin-bottom: 0.25rem; }
.card-title a { color: var(--text); text-decoration: none; }
.card-title a:hover { color: var(--accent); }

.card-summary {
  font-size: 0.8125rem; color: var(--text-muted); line-height: 1.6; margin-bottom: 0.375rem;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card:hover .card-summary { -webkit-line-clamp: unset; }

.card-meta { display: flex; align-items: center; gap: 0.375rem; font-size: 0.75rem; color: var(--text-dim); }

.feed-name::before {
  content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent-light); margin-right: 0.25rem; vertical-align: middle;
}
.sep { color: var(--border-light); }

.tag {
  display: inline-block; font-size: 0.6875rem; padding: 0.0625rem 0.4rem;
  border-radius: 4px; background: var(--tag-bg); color: var(--tag-text); margin-right: 0.25rem;
}

.card-score { flex-shrink: 0; margin-top: 0.125rem; }

.score-ring {
  width: 2.75rem; aspect-ratio: 1; border-radius: 50%;
  display: grid; place-content: center;
  background: conic-gradient(var(--color) calc(var(--pct) * 1%), var(--border) 0);
  position: relative;
}
.score-ring::before {
  content: ""; position: absolute; inset: 3px; border-radius: 50%; background: var(--surface);
}
.score-ring span {
  position: relative; font-size: 0.75rem; font-weight: 700;
  font-variant-numeric: tabular-nums; color: var(--text-muted);
}

.has-detail { cursor: pointer; }
.has-detail:hover .card-title a { text-decoration: underline; }

/* サイドバー スクロールバー */
.sidebar { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.sidebar::-webkit-scrollbar { width: 4px; }
.sidebar::-webkit-scrollbar-track { background: transparent; }
.sidebar::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }
.sidebar::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
[data-theme="dark"] .sidebar::-webkit-scrollbar-thumb { background: #3f3f46; }
[data-theme="dark"] .sidebar::-webkit-scrollbar-thumb:hover { background: #52525b; }

/* スコアツールチップ */
.score-ring[data-tooltip] { cursor: help; }
.score-ring[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.4rem 0.6rem; font-size: 0.7rem; font-weight: 400; color: var(--text);
  white-space: pre; line-height: 1.5; z-index: 100;
  pointer-events: none; opacity: 0; transition: opacity 0.12s ease;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
}
.score-ring[data-tooltip]:hover::after { opacity: 1; }

/* ブックマーク / コピー / エクスポート */
.bookmark-btn {
  background: none; border: none; padding: 0 0.125rem; cursor: pointer;
  color: var(--text-dim); font-size: 0.875rem; line-height: 1;
  transition: color 0.12s ease; flex-shrink: 0;
}
.bookmark-btn:hover { color: #f59e0b; }
.bookmark-btn.is-bookmarked { color: #f59e0b; }

.copy-btn {
  background: none; border: none; padding: 0 0.125rem; cursor: pointer;
  color: var(--text-dim); font-size: 0.75rem; line-height: 1;
  transition: color 0.12s ease; white-space: nowrap; flex-shrink: 0;
}
.copy-btn:hover { color: var(--accent-light); }
.copy-btn.copied { color: #10b981; font-size: 0.6875rem; }

.export-btn {
  display: block; width: 100%; padding: 0.4rem 0.625rem; margin-top: 0.25rem;
  background: none; border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-muted); font-size: 0.8125rem; cursor: pointer;
  text-align: left; transition: all 0.12s ease;
}
.export-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }

/* SNSシェア */
.share-btn {
  background: none; border: 1px solid var(--border-light); border-radius: 4px;
  padding: 0.0625rem 0.375rem; color: var(--text-dim); font-size: 0.6875rem;
  cursor: pointer; transition: all 0.12s ease; white-space: nowrap; margin-left: auto;
}
.share-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
.share-btn.copied { border-color: #10b981; color: #10b981; }

/* キーボードショートカット */
.card.focused { outline: 2px solid var(--accent-light); outline-offset: 1px; }

.kbd-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000; backdrop-filter: blur(2px);
}
.kbd-modal {
  background: var(--surface); border: 1px solid var(--border-light);
  border-radius: 12px; padding: 1.5rem 2rem; max-width: 400px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
.kbd-modal h3 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
.kbd-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.kbd-table td { padding: 0.5rem 0.5rem; color: var(--text-muted); vertical-align: middle; }
.kbd-table td:first-child { width: 110px; white-space: nowrap; }
.kbd-table tr + tr td { border-top: 1px solid var(--border); }
kbd {
  display: inline-block; padding: 0.125rem 0.375rem;
  border: 1px solid var(--border-light); border-radius: 4px;
  background: var(--bg); font-size: 0.75rem; font-family: monospace;
  color: var(--text); line-height: 1.4;
}

/* 詳細パネル（ネイティブ <dialog> 使用） */
#detail-dialog {
  border: 1px solid var(--border); border-radius: 14px; padding: 0;
  width: 760px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 4rem);
  background: var(--surface); color: var(--text);
  box-shadow: 0 24px 64px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.15);
  display: flex; flex-direction: column;
  /* 閉じた状態 */
  opacity: 0; transform: scale(0.95) translateY(2%);
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1),
              display 0.22s allow-discrete, overlay 0.22s allow-discrete;
}
#detail-dialog[open] { opacity: 1; transform: scale(1) translateY(0); }
@starting-style {
  #detail-dialog[open] { opacity: 0; transform: scale(0.95) translateY(2%); }
}
#detail-dialog::backdrop {
  background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
  transition: display 0.22s allow-discrete, overlay 0.22s allow-discrete,
              background-color 0.2s ease;
}
@starting-style {
  #detail-dialog[open]::backdrop { background-color: transparent; }
}

.detail-panel-header {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 1rem 1rem 0.75rem; border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.detail-panel-header h2 {
  flex: 1; font-size: 0.9375rem; font-weight: 600; line-height: 1.5;
  color: var(--text); margin: 0;
}
.detail-panel-close {
  flex-shrink: 0; background: none; border: none; color: var(--text-dim);
  font-size: 1.125rem; cursor: pointer; padding: 0.125rem 0.25rem; line-height: 1;
  transition: color 0.12s ease;
}
.detail-panel-close:hover { color: var(--text); }

.detail-panel-body {
  flex: 1; overflow-y: auto; padding: 1rem;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}
.detail-panel-body::-webkit-scrollbar { width: 4px; }
.detail-panel-body::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }

.detail-panel-summary {
  font-size: 0.875rem; color: var(--text-muted); line-height: 1.75;
  margin: 0 0 1.25rem; padding: 0.75rem 1rem;
  background: var(--bg); border-radius: 8px;
  border-left: 3px solid var(--border-light);
}
.detail-panel-detail-heading {
  font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--text-dim);
  margin: 0 0 0.5rem;
}
.detail-panel-detail {
  font-size: 0.9375rem; color: var(--text); line-height: 2;
  white-space: pre-wrap;
}

.detail-panel-footer {
  padding: 0.875rem 1rem; border-top: 1px solid var(--border); flex-shrink: 0;
}
.detail-panel-link {
  display: block; text-align: center; padding: 0.625rem 1rem;
  background: var(--accent-light); color: #fff; border-radius: 8px;
  font-size: 0.875rem; font-weight: 600; text-decoration: none;
  transition: opacity 0.12s ease;
}
.detail-panel-link:hover { opacity: 0.85; }

.search-wrap { margin-bottom: 1.5rem; }
.search-input {
  width: 100%; padding: 0.5rem 0.875rem; border: 1px solid var(--border);
  border-radius: 8px; background: var(--surface); color: var(--text);
  font-size: 0.875rem; outline: none; transition: border-color 0.12s ease;
}
.search-input:focus { border-color: var(--accent-light); }
.search-input::placeholder { color: var(--text-dim); }

.empty { text-align: center; padding: 4rem 2rem; color: var(--text-dim); }
.empty h2 { font-size: 1.125rem; margin-bottom: 0.5rem; color: var(--text-muted); }

footer { text-align: center; color: var(--text-dim); font-size: 0.6875rem; padding: 1.5rem 0; }
footer a { color: var(--text-dim); text-decoration: none; }
footer a:hover { color: var(--accent-light); }

/* 要約の箇条書き表示 */
.card-summary-list {
  font-size: 0.8125rem; color: var(--text-muted); line-height: 1.6;
  margin-bottom: 0.375rem; padding-left: 1rem; list-style: none;
}
.card-summary-list li { position: relative; padding-left: 0.875rem; margin-bottom: 0.1rem; }
.card-summary-list li::before {
  content: "·"; position: absolute; left: 0; color: var(--accent-light); font-weight: 700;
}
.card:not(:hover) .card-summary-list li:nth-child(n+3) { display: none; }

/* トップへ戻るボタン */
.back-to-top {
  position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 100;
  width: 2.5rem; height: 2.5rem; border-radius: 50%;
  background: var(--accent); color: #fff; border: none;
  font-size: 1rem; cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.back-to-top.visible { opacity: 1; pointer-events: auto; }
@media (any-hover: hover) {
  .back-to-top:hover { transform: translateY(-2px); }
  .card:hover { background: var(--surface-hover); border-color: var(--border-light); }
  .filter-btn:hover { background: var(--surface); color: var(--text); }
  .toc-link:hover { background: var(--surface); color: var(--text); }
  .read-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .skip-btn:hover { border-color: #ef4444; color: #ef4444; background: rgba(239,68,68,0.1); }
  .detail-panel-link:hover { opacity: 0.85; }
  .bookmark-btn:hover { color: #f59e0b; }
  .copy-btn:hover { color: var(--accent-light); }
  .share-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .export-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .theme-toggle:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .mark-section-read:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .skip-section-btn:hover { border-color: #ef4444; color: #ef4444; }
  .score-ring[data-tooltip]:hover::after { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}

@media (max-width: 768px) {
  .layout { flex-direction: column; }
  .sidebar {
    width: 100%; height: auto; position: sticky; top: 0; z-index: 10;
    background: var(--bg); border-right: none; border-bottom: 1px solid var(--border);
    padding: 0.75rem 1rem;
  }
  .sidebar-top { margin-bottom: 0.5rem; }
  .date-label { display: none; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 0.375rem; margin-bottom: 0; }
  .stat-box { padding: 0.375rem 0.625rem; }
  .stat-val { font-size: 1rem; }
  /* フィルター類はトグルで開閉 */
  .sidebar-collapsible { display: none; padding-top: 0.75rem; }
  .sidebar-collapsible.open { display: block; }
  .sidebar-section.toc { display: none; }
  /* トグルボタン */
  .mobile-filter-toggle {
    display: flex; align-items: center; justify-content: center;
    width: 100%; margin-top: 0.5rem; padding: 0.375rem;
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-dim); font-size: 0.75rem; cursor: pointer;
  }
  .mobile-filter-toggle:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .main { padding: 1rem; }
  .score-ring { width: 2.25rem; height: 2.25rem; }
  .score-ring span { font-size: 0.6875rem; }
}
@media (min-width: 769px) {
  .mobile-filter-toggle { display: none; }
  .sidebar-collapsible { display: block !important; }
}

/* ── 設定モーダル ── */
.settings-btn {
  background: none; border: 1px solid var(--border); border-radius: 6px;
  width: 2rem; height: 2rem; cursor: pointer; display: flex; align-items: center;
  justify-content: center; transition: all 0.15s ease; color: var(--text-dim); font-size: 0.875rem;
}
@media (any-hover: hover) {
  .settings-btn:hover { border-color: var(--accent-light); color: var(--accent-light); }
}
#settings-dialog {
  border: 1px solid var(--border); border-radius: 14px; padding: 0;
  width: 420px; max-width: calc(100vw - 2rem);
  background: var(--surface); color: var(--text);
  box-shadow: 0 24px 64px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.15);
}
#settings-dialog::backdrop { background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); }
.settings-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem; border-bottom: 1px solid var(--border);
}
.settings-header h3 { font-size: 0.9375rem; font-weight: 600; }
.settings-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 1.125rem; cursor: pointer; padding: 0.125rem 0.375rem; line-height: 1;
  transition: color 0.12s ease;
}
.settings-close:hover { color: var(--text); }
.settings-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
.settings-field label {
  display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-dim);
  margin-bottom: 0.375rem; text-transform: uppercase; letter-spacing: 0.04em;
}
.settings-input {
  width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--border);
  border-radius: 8px; background: var(--bg); color: var(--text);
  font-size: 0.875rem; font-family: monospace; outline: none;
  transition: border-color 0.12s ease;
}
.settings-input:focus { border-color: var(--accent-light); }
.settings-hint { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem; }
.settings-footer {
  padding: 0.875rem 1.25rem; border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 0.75rem;
}
.settings-save {
  padding: 0.5rem 1.25rem; background: var(--accent); color: #fff;
  border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600;
  cursor: pointer; transition: opacity 0.12s ease; flex-shrink: 0;
}
.settings-save:hover { opacity: 0.85; }
.sync-indicator { font-size: 0.75rem; color: var(--text-dim); margin-left: auto; }
.sync-indicator.syncing { color: var(--accent-light); }
.sync-indicator.synced  { color: #10b981; }
.sync-indicator.error   { color: #ef4444; }
.sidebar-top-actions { display: flex; gap: 0.25rem; align-items: center; }

/* ── モバイルタップ改善 ── */
@media (max-width: 768px) {
  /* read-btn: 44px タップ領域 */
  .read-btn { width: 2.75rem; height: 2.75rem; font-size: 1rem; }
  /* skip-btn: 常時表示・大きめ */
  .skip-btn { opacity: 1; width: 2rem; height: 2rem; font-size: 0.875rem; top: 0.375rem; right: 0.375rem; }
  /* bookmark-btn: 44px タップ領域 + 大きい星アイコン */
  .bookmark-btn {
    font-size: 1.5rem;
    min-width: 2.75rem; min-height: 2.75rem;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0.5rem;
  }
  .copy-btn { font-size: 0.875rem; padding: 0.375rem; }
  .card-meta { gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  /* 詳細パネル: ボトムシートスタイル */
  #detail-dialog {
    width: 100%;
    max-width: 100%;
    max-height: 82vh;
    margin: auto 0 0 0;
    border-radius: 16px 16px 0 0;
    transform: translateY(6px);
  }
  #detail-dialog[open] { transform: translateY(0); }
}
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
document.getElementById('theme-toggle').addEventListener('click', cycleTheme);

// ── 既読 / スキップ状態 (localStorage) ───────────────
var READ_KEY = 'news_read_v2';
var SKIP_KEY = 'news_skip_v2';

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
      var btn = card.querySelector('.read-btn');
      if (btn) { btn.classList.add('is-read'); btn.textContent = '\\u2713'; }
    }
  });
}

function toggleRead(card) {
  var id = Number(card.dataset.id);
  var readIds = getSet(READ_KEY);
  var btn = card.querySelector('.read-btn');
  if (card.classList.contains('read')) {
    card.classList.remove('read');
    if (btn) { btn.classList.remove('is-read'); btn.textContent = ''; }
    readIds.delete(id);
  } else {
    card.classList.add('read');
    if (btn) { btn.classList.add('is-read'); btn.textContent = '\\u2713'; }
    readIds.add(id);
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
  var btn = card.querySelector('.read-btn');
  if (btn) { btn.classList.add('is-read'); btn.textContent = '\\u2713'; }
  readIds.add(id);
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
    var rb = card.querySelector('.read-btn');
    if (rb) { rb.classList.add('is-read'); rb.textContent = '\\u2713'; }
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
    var countEl = link.querySelector('.toc-count');
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
    var title = (card.querySelector('.card-title') || {}).textContent || '';
    var summary = (card.querySelector('.card-summary') || {}).textContent || '';
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
      var cardLink = card.querySelector('.card-title a');
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
  setActiveBtn('category-filters', cat);
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
    btn.className = 'filter-btn';
    btn.dataset.value = source;
    btn.textContent = source;
    container.appendChild(btn);
  });
}

// ── イベント委譲 ──────────────────────────────────────
document.querySelector('.main').addEventListener('click', function(e) {
  var readBtn = e.target.closest('.read-btn');
  if (readBtn) { toggleRead(readBtn.closest('.card')); return; }

  var skipBtn = e.target.closest('.skip-btn');
  if (skipBtn) { dismissArticle(skipBtn.closest('.card')); return; }

  var markBtn = e.target.closest('.mark-section-read');
  if (markBtn) { markSectionRead(markBtn); return; }

  var skipSecBtn = e.target.closest('.skip-section-btn');
  if (skipSecBtn) { skipSectionAll(skipSecBtn); return; }

  var shareBtn = e.target.closest('.share-btn');
  if (shareBtn) { shareArticle(shareBtn); return; }

  var articleLink = e.target.closest('.card-title a');
  if (articleLink) { markRead(articleLink.closest('.card')); return; }

  var card = e.target.closest('.card.has-detail');
  if (card && !e.target.closest('.read-btn, .skip-btn, .bookmark-btn, .copy-btn, .share-btn')) {
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

document.getElementById('category-filters').addEventListener('click', function(e) {
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
var mobileToggle = document.getElementById('mobile-filter-toggle');
var sidebarCollapsible = document.getElementById('sidebar-collapsible');
if (mobileToggle && sidebarCollapsible) {
  mobileToggle.addEventListener('click', function() {
    var isOpen = sidebarCollapsible.classList.toggle('open');
    mobileToggle.textContent = isOpen ? 'フィルター ▴' : 'フィルター ▾';
  });
}

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
  if (!el) return;
  el.className = 'sync-indicator' + (status ? ' ' + status : '');
  el.textContent = msg;
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
    var link = card.querySelector('.card-title a');
    var bBtn = card.querySelector('.bookmark-btn');
    if (!link || !bBtn) return;
    var bookmarked = isBookmarked(link.href);
    bBtn.className = 'bookmark-btn' + (bookmarked ? ' is-bookmarked' : '');
    bBtn.setAttribute('aria-label', bookmarked ? 'ブックマーク解除' : 'ブックマークに追加');
    bBtn.textContent = bookmarked ? '\\u2605' : '\\u2606';
  });
  applyFilters();
}

document.querySelectorAll('.card').forEach(function(card) {
  var link = card.querySelector('.card-title a');
  if (!link) return;
  var meta = card.querySelector('.card-meta');
  if (!meta) return;
  var bookmarked = isBookmarked(link.href);
  var bBtn = document.createElement('button');
  bBtn.className = 'bookmark-btn' + (bookmarked ? ' is-bookmarked' : '');
  bBtn.setAttribute('aria-label', bookmarked ? 'ブックマーク解除' : 'ブックマークに追加');
  bBtn.textContent = bookmarked ? '\u2605' : '\u2606';
  meta.appendChild(bBtn);
  var cBtn = document.createElement('button');
  cBtn.className = 'copy-btn';
  cBtn.setAttribute('aria-label', 'URLをコピー');
  cBtn.textContent = '\uD83D\uDD17';
  meta.appendChild(cBtn);
});

document.querySelector('.main').addEventListener('click', function(e) {
  var bBtn = e.target.closest('.bookmark-btn');
  if (bBtn) {
    var bCard = bBtn.closest('.card');
    if (!bCard) return;
    var bLink = bCard.querySelector('.card-title a');
    if (!bLink) return;
    var nowBm = toggleBookmark(bLink.href);
    bBtn.textContent = nowBm ? '\u2605' : '\u2606';
    bBtn.classList.toggle('is-bookmarked', nowBm);
    bBtn.setAttribute('aria-label', nowBm ? 'ブックマーク解除' : 'ブックマークに追加');
    return;
  }
  var cBtn = e.target.closest('.copy-btn');
  if (cBtn) {
    var cCard = cBtn.closest('.card');
    if (!cCard) return;
    var cLink = cCard.querySelector('.card-title a');
    if (!cLink) return;
    navigator.clipboard.writeText(cLink.href).then(function() {
      cBtn.textContent = '\u2713 Copied';
      cBtn.classList.add('copied');
      setTimeout(function() { cBtn.textContent = '\uD83D\uDD17'; cBtn.classList.remove('copied'); }, 1000);
    });
    return;
  }
});

function exportBookmarks() {
  var bms = getBookmarks();
  if (bms.length === 0) { alert('ブックマークがありません'); return; }
  var today = new Date().toISOString().slice(0, 10);
  var lines = ['# Bookmarks - ' + today, ''];
  bms.forEach(function(url) {
    var title = url;
    document.querySelectorAll('.card-title a').forEach(function(a) {
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
function initShareButtons() {
  document.querySelectorAll('.card').forEach(function(card) {
    var link = card.querySelector('.card-title a');
    var meta = card.querySelector('.card-meta');
    if (!link || !meta) return;
    var btn = document.createElement('button');
    btn.className = 'share-btn';
    btn.textContent = 'Share';
    btn.dataset.shareUrl = link.href;
    btn.dataset.shareTitle = link.textContent.trim();
    btn.setAttribute('aria-label', 'SNSシェア');
    meta.insertBefore(btn, meta.firstChild);
  });
}

function shareArticle(btn) {
  var text = (btn.dataset.shareTitle || '') + ' ' + (btn.dataset.shareUrl || '') + ' #NewsDigest';
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = '\u2713 Copied for X';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Share'; btn.classList.remove('copied'); }, 1000);
  });
}

// ── スコアツールチップ ────────────────────────────────
var TIER_LABELS = {
  'must-read':    { label: 'Must Read',    threshold: '0.85以上' },
  'recommended':  { label: 'Recommended', threshold: '0.70〜0.84' },
  'worth-a-look': { label: 'Worth a Look', threshold: '0.50〜0.69' },
  'low-priority': { label: 'Low Priority', threshold: '0.50未満' }
};
document.querySelectorAll('.card').forEach(function(card) {
  var ring = card.querySelector('.score-ring');
  if (!ring) return;
  var tier = card.dataset.tier || '';
  var score = (ring.querySelector('span') || {}).textContent || '';
  var info = TIER_LABELS[tier];
  if (!info) return;
  ring.setAttribute('data-tooltip', 'スコア: ' + score + '\\nTier: ' + info.label + '\\n基準: ' + info.threshold);
});

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
        var bLink = focusedCard.querySelector('.card-title a');
        var bBtn = focusedCard.querySelector('.bookmark-btn');
        if (bLink && bBtn) {
          var nowBm = toggleBookmark(bLink.href);
          bBtn.textContent = nowBm ? '\u2605' : '\u2606';
          bBtn.classList.toggle('is-bookmarked', nowBm);
        }
      }
      break;
    case '?': showKbdModal(); e.preventDefault(); break;
    case 'Escape': if (kbdModal) { kbdModal.remove(); kbdModal = null; } break;
  }
});

// ── トップへ戻る ──────────────────────────────────────
var backToTopBtn = document.getElementById('back-to-top');
var mainEl = document.querySelector('.main');
mainEl.addEventListener('scroll', function() {
  backToTopBtn.classList.toggle('visible', mainEl.scrollTop > 400);
}, { passive: true });
window.addEventListener('scroll', function() {
  backToTopBtn.classList.toggle('visible', window.scrollY > 400);
}, { passive: true });
backToTopBtn.addEventListener('click', function() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  mainEl.scrollTo({ top: 0, behavior: 'smooth' });
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
restoreState();
buildSourceFilters();
setActiveBtn('read-filters', currentReadFilter);
setActiveBtn('category-filters', currentCategoryFilter);
setActiveBtn('date-filters', currentDateFilter);
setActiveBtn('source-filters', currentSourceFilter);
applyFilters();
initShareButtons();
loadFromGist();
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

  // サイドバー TOC
  const tocLinks = TIERS.filter((t) => (tierMap.get(t.id)?.length ?? 0) > 0)
    .map(
      (t) => `<a class="toc-link" href="#${t.id}">
        <span class="toc-dot" style="background:${t.color}"></span>
        ${t.label}
        <span class="toc-count">${tierMap.get(t.id)!.length}</span>
      </a>`
    )
    .join("\n");

  // カテゴリフィルターボタン
  const catButtons = ["all", ...categories]
    .map((c) => {
      const label = c === "all" ? "すべて" : categoryLabel(c);
      const active = c === "all" ? ' class="filter-btn active"' : ' class="filter-btn"';
      return `<button type="button"${active} data-value="${esc(c)}">${esc(label)}</button>`;
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
<div class="layout">

<aside class="sidebar">
  <div class="sidebar-top">
    <div class="logo">
      <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 11a9 9 0 0 1 9 9"/>
        <path d="M4 4a16 16 0 0 1 16 16"/>
        <circle cx="5" cy="19" r="1"/>
      </svg>
      News Digest
    </div>
    <div class="sidebar-top-actions">
      <button type="button" class="settings-btn" id="settings-btn" title="同期設定">&#9881;</button>
      <button type="button" class="theme-toggle" id="theme-toggle" title="テーマ切り替え">
        <span class="theme-icon"></span>
      </button>
    </div>
  </div>
  <div class="date-label">${today}</div>

  <div class="stats-grid">
    <div class="stat-box">
      <div class="stat-val">${rows.length}</div>
      <div class="stat-lbl">記事</div>
    </div>
    <div class="stat-box">
      <div class="stat-val" id="unread-count">${rows.length}</div>
      <div class="stat-lbl">未読</div>
    </div>
  </div>

  <button type="button" class="mobile-filter-toggle" id="mobile-filter-toggle">フィルター ▾</button>

  <div class="sidebar-collapsible" id="sidebar-collapsible">
    <div class="sidebar-section" id="read-filters">
      <div class="sidebar-heading">表示</div>
      <div class="filter-list">
        <button type="button" class="filter-btn active" data-value="all">すべて</button>
        <button type="button" class="filter-btn" data-value="unread">未読のみ</button>
        <button type="button" class="filter-btn" data-value="read">既読のみ</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-heading">カテゴリ</div>
      <div class="filter-list" id="category-filters">
        ${catButtons}
      </div>
    </div>

    <div class="sidebar-section" id="date-filters">
      <div class="sidebar-heading">期間</div>
      <div class="filter-list">
        <button type="button" class="filter-btn active" data-value="all">すべて</button>
        <button type="button" class="filter-btn" data-value="today">今日</button>
        <button type="button" class="filter-btn" data-value="3days">3日</button>
        <button type="button" class="filter-btn" data-value="week">1週間</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-heading">ソース</div>
      <div class="filter-list" id="source-filters">
        <button type="button" class="filter-btn active" data-value="all">すべて</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-heading">ブックマーク</div>
      <div class="filter-list">
        <button class="filter-btn" id="bookmark-filter-btn" data-value="bookmarked">★ ブックマーク</button>
      </div>
      <button type="button" class="export-btn" id="export-bookmarks-btn">📥 書き出す</button>
    </div>

    <div class="sidebar-section toc">
      <div class="sidebar-heading">セクション</div>
      ${tocLinks}
    </div>
  </div>
</aside>

<main class="main">
  <search class="search-wrap">
    <input id="search" class="search-input" type="search" placeholder="キーワード検索..." aria-label="記事を検索">
  </search>

  ${sections}

  <div id="no-results" class="empty" style="display:none">
    <h2>記事が見つかりません</h2>
    <p>フィルターを変更するか、検索キーワードを変えてみてください。</p>
  </div>

  <footer>更新: ${updatedAt}</footer>
</main>

</div>

<!-- トップへ戻るボタン -->
<button type="button" class="back-to-top" id="back-to-top" aria-label="トップへ戻る">↑</button>

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
