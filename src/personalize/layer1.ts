import type { CategoryReadRow } from "../db/queries";

/**
 * Layer1: カテゴリ別読了率（30日指数減衰）から affinity マップを計算する。
 * affinity[category] = 0.0〜1.0（全カテゴリの decayed_count に占める割合）
 */
export function computeTagAffinity(rows: CategoryReadRow[]): Map<string, number> {
  const total = rows.reduce((sum, r) => sum + r.decayed_count, 0);
  const affinity = new Map<string, number>();
  if (total === 0) return affinity;
  for (const row of rows) {
    affinity.set(row.category, row.decayed_count / total);
  }
  return affinity;
}

/**
 * Layer1 ブーストを summaries の personal_score に適用する。
 * personal_score = min(1.0, ai_score + affinity[category] * 0.2)
 * 読了履歴がない場合は personal_score = ai_score のまま。
 */
export function applyTagBoost(
  summaries: Array<{ article_id: number; ai_score: number; category: string }>,
  affinity: Map<string, number>,
  updateFn: (article_id: number, personal_score: number) => void
): number {
  let updated = 0;
  for (const s of summaries) {
    const boost = (affinity.get(s.category) ?? 0) * 0.2;
    const personalScore = Math.min(1.0, s.ai_score + boost);
    updateFn(s.article_id, personalScore);
    updated++;
  }
  return updated;
}
