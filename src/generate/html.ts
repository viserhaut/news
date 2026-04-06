import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { DigestArticleRow } from "../db/queries";
import { initDb } from "../db/schema";
import { makeQueries } from "../db/queries";

type Queries = ReturnType<typeof import("../db/queries").makeQueries>;

// ── HTML エスケープ ───────────────────────────────────
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
  // href に使う URL: https:// のみ許可
  if (!url.startsWith("https://") && !url.startsWith("http://")) return "";
  return esc(url);
}

function safeImgSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("https://")) return null;
  return esc(url);
}

// ── 日付フォーマット ──────────────────────────────────
function formatDate(isoStr: string | null): string {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  } catch {
    return "";
  }
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
  other: "その他",
};

function categoryLabel(cat: string): string {
  return esc(CATEGORY_LABELS[cat] ?? cat);
}

// ── カード HTML テンプレート ───────────────────────────
function cardHtml(a: DigestArticleRow): string {
  const score = typeof a.personal_score === "number" ? a.personal_score : 0;
  const scorePct = Math.round(score * 100);
  const imgSrc = safeImgSrc(a.og_image);
  const imgHtml = imgSrc
    ? `<img src="${imgSrc}" alt="" class="card-img" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="card-img-placeholder">${categoryLabel(a.category)}</div>`;

  return `<article class="card" data-id="${a.id}" data-category="${esc(a.category)}">
  <a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer" class="card-link">
    <div class="card-media">${imgHtml}</div>
    <div class="card-body">
      <div class="card-meta-top">
        <span class="badge">${categoryLabel(a.category)}</span>
        <span class="source">${esc(a.source_id)}</span>
        <span class="date">${formatDate(a.published_at)}</span>
      </div>
      <h2 class="card-title">${esc(a.title_ja ?? a.url)}</h2>
      <p class="card-summary">${esc(a.summary_ja ?? "")}</p>
      <div class="score-bar" title="スコア: ${scorePct}%">
        <div class="score-fill" style="width:${scorePct}%"></div>
      </div>
    </div>
  </a>
</article>`;
}

// ── CSS ───────────────────────────────────────────────
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f5f5;--surface:#fff;--text:#111;--text-muted:#666;
  --border:#e0e0e0;--primary:#1a73e8;--badge-bg:#e8f0fe;--badge-text:#1a73e8;
  --score-bg:#e0e0e0;--score-fill:#34a853;--read-opacity:0.5;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#181a1b;--surface:#242628;--text:#e8e8e8;--text-muted:#999;
  --border:#383a3c;--primary:#8ab4f8;--badge-bg:#2a3a5c;--badge-text:#8ab4f8;
  --score-bg:#444;--score-fill:#4caf50;
}}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:10}
.header-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.site-title{font-size:18px;font-weight:700;color:var(--text)}
.updated{font-size:12px;color:var(--text-muted);margin-left:auto}
.controls{max-width:1200px;margin:16px auto;padding:0 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.filter-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:13px;transition:background .15s}
.filter-btn:hover,.filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
#search{border:1px solid var(--border);background:var(--surface);color:var(--text);padding:6px 12px;border-radius:20px;font-size:13px;width:200px;outline:none}
#search:focus{border-color:var(--primary)}
#grid{max-width:1200px;margin:0 auto;padding:0 16px 32px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;transition:box-shadow .15s,opacity .15s}
.card:hover{box-shadow:0 4px 12px rgba(0,0,0,.12)}
.card.read{opacity:var(--read-opacity)}
.card-link{display:block;text-decoration:none;color:inherit;height:100%}
.card-media{height:160px;background:var(--badge-bg);display:flex;align-items:center;justify-content:center;overflow:hidden}
.card-img{width:100%;height:100%;object-fit:cover}
.card-img-placeholder{font-size:13px;color:var(--badge-text);font-weight:600}
.card-body{padding:12px}
.card-meta-top{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
.badge{background:var(--badge-bg);color:var(--badge-text);font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px}
.source{font-size:11px;color:var(--text-muted)}
.date{font-size:11px;color:var(--text-muted);margin-left:auto}
.card-title{font-size:14px;font-weight:600;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-summary{font-size:13px;color:var(--text-muted);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:8px}
.score-bar{height:3px;background:var(--score-bg);border-radius:2px;overflow:hidden}
.score-fill{height:100%;background:var(--score-fill);border-radius:2px}
#empty{display:none;text-align:center;padding:40px;color:var(--text-muted);grid-column:1/-1}
@media(max-width:600px){
  .header-inner{gap:8px}
  .controls{gap:6px}
  #search{width:100%}
  #grid{grid-template-columns:1fr;padding:0 10px 24px}
}
`;

// ── Vanilla JS ────────────────────────────────────────
function buildJs(safeJson: string, categories: string[], updatedAt: string): string {
  const catBtns = ["all", ...categories]
    .map((c) => {
      const label = c === "all" ? "すべて" : CATEGORY_LABELS[c] ?? c;
      const active = c === "all" ? ' class="filter-btn active"' : ' class="filter-btn"';
      return `<button${active} data-cat="${c.replace(/"/g, "&quot;")}">${label}</button>`;
    })
    .join("\n    ");

  return `(function(){
const ARTICLES=${safeJson};
let activeCategory="all",searchQuery="",debounceTimer=null;
const READ_KEY="news_read_v1";

function getReadIds(){try{return new Set(JSON.parse(localStorage.getItem(READ_KEY)||"[]"))}catch{return new Set()}}
function markRead(id){const s=getReadIds();s.add(id);localStorage.setItem(READ_KEY,JSON.stringify([...s]))}

function getFiltered(){
  const q=searchQuery.toLowerCase();
  return ARTICLES.filter(a=>{
    const catOk=activeCategory==="all"||a.category===activeCategory;
    const srchOk=!q||(a.title_ja||"").toLowerCase().includes(q)||(a.summary_ja||"").toLowerCase().includes(q);
    return catOk&&srchOk;
  });
}

function renderCards(list){
  const grid=document.getElementById("grid");
  const empty=document.getElementById("empty");
  if(!list.length){grid.innerHTML="";empty.style.display="block";return;}
  empty.style.display="none";
  const readIds=getReadIds();
  grid.innerHTML=list.map(a=>{
    const score=Math.round((a.personal_score||0)*100);
    const img=a.og_image?
      \`<img src="\${a.og_image}" alt="" class="card-img" loading="lazy" onerror="this.style.display='none'">\`:
      \`<div class="card-img-placeholder">\${a.category_label}</div>\`;
    const readClass=readIds.has(a.id)?" read":"";
    return \`<article class="card\${readClass}" data-id="\${a.id}" data-category="\${a.category}">
<a href="\${a.url}" target="_blank" rel="noopener noreferrer" class="card-link" data-id="\${a.id}">
<div class="card-media">\${img}</div>
<div class="card-body">
<div class="card-meta-top"><span class="badge">\${a.category_label}</span><span class="source">\${a.source_id}</span><span class="date">\${a.date}</span></div>
<h2 class="card-title">\${a.title_ja}</h2>
<p class="card-summary">\${a.summary_ja}</p>
<div class="score-bar"><div class="score-fill" style="width:\${score}%"></div></div>
</div></a></article>\`;
  }).join("");

  // カードクリックで既読マーク
  grid.querySelectorAll(".card-link[data-id]").forEach(el=>{
    el.addEventListener("click",function(){
      const id=Number(this.dataset.id);
      markRead(id);
      const card=this.closest(".card");
      if(card)card.classList.add("read");
    });
  });
}

// フィルタボタン初期化
const controls=document.getElementById("controls");
controls.innerHTML=\`<div id="filter-btns">
    ${catBtns}
  </div>
  <input id="search" type="search" placeholder="キーワード検索..." aria-label="キーワード検索">\`;

controls.querySelectorAll(".filter-btn").forEach(btn=>{
  btn.addEventListener("click",function(){
    controls.querySelectorAll(".filter-btn").forEach(b=>b.classList.remove("active"));
    this.classList.add("active");
    activeCategory=this.dataset.cat;
    renderCards(getFiltered());
  });
});

const searchEl=document.getElementById("search");
searchEl.addEventListener("input",function(){
  clearTimeout(debounceTimer);
  debounceTimer=setTimeout(()=>{searchQuery=this.value.trim();renderCards(getFiltered());},300);
});

// 最終更新日時
document.getElementById("updated").textContent="更新: ${updatedAt}";
document.getElementById("article-count").textContent=ARTICLES.length+"件";

renderCards(getFiltered());
})();`;
}

// ── メイン生成関数 ────────────────────────────────────
export async function generateHtml(
  _db: Database,
  q: Queries,
  rootDir: string
): Promise<void> {
  const rows = q.selectDigestArticles.all() as DigestArticleRow[];

  // クライアント側で使う軽量データに変換（エスケープ済み）
  const cards = rows.map((a) => ({
    id: a.id,
    url: safeUrl(a.url),
    title_ja: esc(a.title_ja ?? a.url),
    summary_ja: esc(a.summary_ja ?? ""),
    category: esc(a.category),
    category_label: categoryLabel(a.category),
    source_id: esc(a.source_id),
    date: formatDate(a.published_at),
    og_image: safeImgSrc(a.og_image),
    personal_score: typeof a.personal_score === "number" ? a.personal_score : 0,
  }));

  // JSON を <script> タグ内に安全に埋め込む
  const safeJson = JSON.stringify(cards).replace(/<\/script>/gi, "<\\/script>");

  // カテゴリ一覧（重複排除・出現順）
  const categories = [...new Set(rows.map((a) => a.category))];

  const updatedAt = new Date().toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

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
</head>
<body>
<header>
  <div class="header-inner">
    <span class="site-title">News Digest</span>
    <span id="article-count" class="updated"></span>
    <span id="updated" class="updated"></span>
  </div>
</header>
<div class="controls" id="controls"></div>
<div id="grid" role="list"></div>
<div id="empty">記事が見つかりません</div>
<script>
${buildJs(safeJson, categories, updatedAt)}
</script>
</body>
</html>`;

  const docsDir = join(rootDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "index.html"), html, "utf-8");
}

// ── スタンドアロン実行エントリーポイント ────────────────
if (import.meta.main) {
  const ROOT_DIR = join(import.meta.dir, "../..");
  const DB_PATH = process.env.DB_PATH ?? join(ROOT_DIR, "data", "digest.db");
  const db = initDb(DB_PATH);
  const q = makeQueries(db);
  await generateHtml(db, q, ROOT_DIR);
  db.close();
  console.log("[done] docs/index.html generated");
}
