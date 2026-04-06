import { callClaude } from "../llm/claude";
import type { RecentReadRow } from "../db/queries";

const PROFILE_REGEN_THRESHOLD = 10; // 前回から N 件新規読了で再生成

/**
 * Layer2: 最近の読了履歴から Claude でセマンティックプロファイルを生成する。
 * 再生成は前回プロファイル生成以降に PROFILE_REGEN_THRESHOLD 件以上読了した場合のみ。
 */
export async function maybeGenerateProfile(
  recentReads: RecentReadRow[],
  lastProfile: { profile: string; based_on: number } | null,
  totalReadCount: number,
  saveFn: (profile: string, basedOn: number) => void
): Promise<string | null> {
  // 読了履歴がなければスキップ
  if (recentReads.length === 0) return null;

  // 初回 or 前回から十分な読了数があれば再生成
  const readsSinceLast = lastProfile ? totalReadCount - lastProfile.based_on : totalReadCount;
  if (lastProfile && readsSinceLast < PROFILE_REGEN_THRESHOLD) {
    // 再生成不要: 既存プロファイルを返す
    return lastProfile.profile;
  }

  const prompt = buildProfilePrompt(recentReads);
  const raw = await callClaude(prompt);
  const profile = raw.trim();

  saveFn(profile, totalReadCount);
  console.log(`[personalize] Semantic profile updated (based on ${totalReadCount} reads)`);
  return profile;
}

function buildProfilePrompt(reads: RecentReadRow[]): string {
  // プロンプトインジェクション緩和: JSON.stringify で自動エスケープ
  const readList = reads.map((r) => ({
    title: r.title_ja ?? r.title,
    category: r.category,
    source: r.source_id,
    feedback: r.feedback ?? "read",
  }));

  return `以下は私が最近読んだ記事の一覧です（最新順、最大100件）。
私の興味・関心・スキルレベルを分析して、100字以内で簡潔なプロファイル文を書いてください。
プロファイル文のみを出力してください。前置きや説明は不要です。

${JSON.stringify(readList, null, 2)}`;
}
