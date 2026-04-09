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

// ── カード HTML ───────────────────────────────────────
function cardHtml(a: DigestArticleRow): string {
  const score = typeof a.personal_score === "number" ? a.personal_score : 0;
  const scorePct = Math.round(score * 100);
  const tier = getTier(score);

  return `<article class="card${a.detail_summary_ja ? " has-detail" : ""}" data-id="${a.id}" data-category="${esc(a.category)}" data-tier="${tier.id}" data-date="${esc(a.published_at ?? "")}"${a.detail_summary_ja ? ` data-detail="${esc(a.detail_summary_ja)}" data-url="${safeUrl(a.url)}" data-title="${esc(a.title_ja ?? a.url)}" data-summary="${esc(a.summary_ja ?? "")}"` : ""}>
  <div class="card-row">
    <button class="read-btn" aria-label="既読にする"></button>
    <button class="skip-btn" aria-label="スキップ">✕</button>
    <div class="card-body">
      <h3 class="card-title"><a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title_ja ?? a.url)}</a></h3>
      <p class="card-summary">${esc(a.summary_ja ?? "")}</p>
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
    <button class="mark-section-read">既読</button>
    <button class="skip-section-btn">スキップ</button>
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
  padding: 1rem 1.25rem; margin-bottom: 0.5rem; transition: all 0.15s ease;
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
  flex-shrink: 0; width: 1.375rem; height: 1.375rem; margin-top: 0.125rem;
  background: none; border: 1.5px solid var(--border-light); border-radius: 50%;
  cursor: pointer; color: var(--text-dim); font-size: 0.6875rem;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.12s ease; padding: 0;
}
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
  width: 2.75rem; height: 2.75rem; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
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

/* 詳細パネル */
.detail-overlay {
  display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  z-index: 200; backdrop-filter: blur(2px);
}
.detail-overlay.open { display: block; }

.detail-panel {
  position: fixed; top: 0; right: 0; height: 100%; width: 420px; max-width: 100%;
  background: var(--surface); border-left: 1px solid var(--border);
  z-index: 201; display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform 0.25s ease;
  box-shadow: -4px 0 24px rgba(0,0,0,0.15);
}
.detail-panel.open { transform: translateX(0); }

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
  font-size: 0.8125rem; color: var(--text-muted); line-height: 1.7;
  margin: 0 0 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-light);
}
.detail-panel-detail {
  font-size: 0.8125rem; color: var(--text-muted); line-height: 1.9;
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
var currentSearch = '';

function updateURL() {
  var p = new URLSearchParams(location.search);
  currentReadFilter === 'all' ? p.delete('read') : p.set('read', currentReadFilter);
  currentCategoryFilter === 'all' ? p.delete('category') : p.set('category', currentCategoryFilter);
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

  var articleLink = e.target.closest('.card-title a');
  if (articleLink) { markRead(articleLink.closest('.card')); return; }

  var card = e.target.closest('.card.has-detail');
  if (card && !e.target.closest('.read-btn, .skip-btn')) {
    openDetailPanel(card);
  }
});

// ── 詳細パネル ────────────────────────────────────────
var detailPanel = document.getElementById('detail-panel');
var detailOverlay = document.getElementById('detail-overlay');

function openDetailPanel(card) {
  document.getElementById('detail-panel-title').textContent = card.dataset.title || '';
  document.getElementById('detail-panel-summary').textContent = card.dataset.summary || '';
  document.getElementById('detail-panel-detail').textContent = card.dataset.detail || '';
  var link = document.getElementById('detail-panel-link');
  link.href = card.dataset.url || '#';
  detailPanel.classList.add('open');
  detailOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDetailPanel() {
  detailPanel.classList.remove('open');
  detailOverlay.classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('detail-panel-close').addEventListener('click', closeDetailPanel);
detailOverlay.addEventListener('click', closeDetailPanel);
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && detailPanel.classList.contains('open')) closeDetailPanel();
});

document.getElementById('category-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterByCategory(btn.dataset.value || 'all');
});

document.getElementById('read-filters').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (btn) filterArticles(btn.dataset.value || 'all');
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

// ── 初期化 ────────────────────────────────────────────
restoreState();
setActiveBtn('read-filters', currentReadFilter);
setActiveBtn('category-filters', currentCategoryFilter);
applyFilters();
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
    const tier = getTier(score);
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
      return `<button${active} data-value="${esc(c)}">${esc(label)}</button>`;
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
      content="default-src 'self'; img-src https: data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<meta name="robots" content="noindex,nofollow">
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
    <button class="theme-toggle" id="theme-toggle" title="テーマ切り替え">
      <span class="theme-icon"></span>
    </button>
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

  <button class="mobile-filter-toggle" id="mobile-filter-toggle">フィルター ▾</button>

  <div class="sidebar-collapsible" id="sidebar-collapsible">
    <div class="sidebar-section" id="read-filters">
      <div class="sidebar-heading">表示</div>
      <div class="filter-list">
        <button class="filter-btn active" data-value="all">すべて</button>
        <button class="filter-btn" data-value="unread">未読のみ</button>
        <button class="filter-btn" data-value="read">既読のみ</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-heading">カテゴリ</div>
      <div class="filter-list" id="category-filters">
        ${catButtons}
      </div>
    </div>

    <div class="sidebar-section toc">
      <div class="sidebar-heading">セクション</div>
      ${tocLinks}
    </div>
  </div>
</aside>

<main class="main">
  <div class="search-wrap">
    <input id="search" class="search-input" type="search" placeholder="キーワード検索..." aria-label="記事を検索">
  </div>

  ${sections}

  <div id="no-results" class="empty" style="display:none">
    <h2>記事が見つかりません</h2>
    <p>フィルターを変更するか、検索キーワードを変えてみてください。</p>
  </div>

  <footer>更新: ${updatedAt}</footer>
</main>

</div>

<!-- 詳細パネル -->
<div class="detail-overlay" id="detail-overlay"></div>
<div class="detail-panel" id="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-panel-title">
  <div class="detail-panel-header">
    <h2 id="detail-panel-title"></h2>
    <button class="detail-panel-close" id="detail-panel-close" aria-label="閉じる">✕</button>
  </div>
  <div class="detail-panel-body">
    <p class="detail-panel-summary" id="detail-panel-summary"></p>
    <div class="detail-panel-detail" id="detail-panel-detail"></div>
  </div>
  <div class="detail-panel-footer">
    <a class="detail-panel-link" id="detail-panel-link" href="#" target="_blank" rel="noopener noreferrer">元記事を読む →</a>
  </div>
</div>

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
