import { readFileSync } from "fs";
import { join } from "path";

// SSRF 防止: プライベート IP レンジと localhost を拒否
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost[:/]/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/0\./,
];

export interface Source {
  id: string;
  name: string;
  rss_url: string;
  language: "ja" | "en";
  category: string;
  max_items: number;
  enabled: boolean;
}

interface SourcesYaml {
  sources: Source[];
}

export function validateUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid URL scheme (must be http:// or https://): ${url}`);
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`Private/localhost URL is not allowed: ${url}`);
    }
  }
}

export function loadSources(rootDir: string): Source[] {
  const yamlPath = join(rootDir, "sources.yml");
  const raw = readFileSync(yamlPath, "utf-8");

  // 軽量 YAML パース（依存追加不要、sources.yml の構造は固定）
  const parsed = parseSourcesYaml(raw);

  const sources: Source[] = [];
  for (const s of parsed.sources) {
    if (!s.enabled) continue;
    validateUrl(s.rss_url);
    sources.push(s);
  }
  return sources;
}

// シンプルな sources.yml パーサー（bun 組み込みの Bun.file で YAML をテキスト処理）
// 外部 YAML ライブラリ不使用。構造が固定なので正規表現ベースで対応。
function parseSourcesYaml(raw: string): SourcesYaml {
  const sources: Source[] = [];
  // sources: の後ろの各エントリを "-" で分割
  const entriesSection = raw.replace(/^sources:\s*/m, "");
  // "  - id:" で始まるブロックごとに分割
  const blocks = entriesSection.split(/\n(?=\s*-\s+id:)/);

  for (const block of blocks) {
    if (!block.trim()) continue;
    const get = (key: string): string | undefined => {
      // "  - id: val" と "    name: val" の両方に対応するため (?:-\s+)? でプレフィックスを許容
      const m = block.match(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.+)$`, "m"));
      return m?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    };

    const id = get("id");
    const name = get("name");
    const rss_url = get("rss_url");
    const language = get("language");
    const category = get("category");
    const max_items = get("max_items");
    const enabled = get("enabled");

    if (!id || !name || !rss_url || !language || !category) continue;

    sources.push({
      id,
      name,
      rss_url,
      language: language as "ja" | "en",
      category,
      max_items: max_items ? parseInt(max_items, 10) : 10,
      enabled: enabled !== "false",
    });
  }

  return { sources };
}
