import type { UserPreference } from "../db/queries";

/**
 * Layer3: Layer1 の tagAffinity と Layer2 のセマンティックプロファイルを
 * プロンプトに注入するためのコンテキスト文字列を生成する。
 */
export function buildPersonalContext(
  tagAffinity: Map<string, number>,
  semanticProfile: string | null,
  preferences: UserPreference[]
): string | null {
  // 読了履歴がなく、プロファイルも preferences もない場合は注入しない
  if (tagAffinity.size === 0 && !semanticProfile && preferences.length === 0) {
    return null;
  }

  const lines: string[] = ["## ユーザープロファイル（パーソナライズ情報）"];

  // タグ affinity（上位3カテゴリを表示）
  if (tagAffinity.size > 0) {
    const sorted = [...tagAffinity.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, score]) => `${cat}=${score.toFixed(2)}`);
    lines.push(`読了傾向（カテゴリ別スコア）: ${sorted.join(", ")}`);
  }

  // セマンティックプロファイル
  if (semanticProfile) {
    lines.push(`プロファイル: ${semanticProfile}`);
  }

  // ユーザー設定（ブースト/サプレス）
  const boosts = preferences.filter((p) => p.type.startsWith("boost")).map((p) => p.value);
  const suppresses = preferences.filter((p) => p.type.startsWith("suppress")).map((p) => p.value);
  if (boosts.length > 0) lines.push(`ブースト優先: ${boosts.join(", ")}`);
  if (suppresses.length > 0) lines.push(`サプレス除外: ${suppresses.join(", ")}`);

  return lines.join("\n");
}
