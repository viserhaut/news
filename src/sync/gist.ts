import type { makeQueries } from "../db/queries";

const GIST_FILE = "news-digest-sync.json";
const GIST_TIMEOUT_MS = 10_000;

interface GistSyncData {
  read?: number[];
}

export async function syncGistReads(
  q: ReturnType<typeof makeQueries>,
  gistPat: string,
  gistId: string
): Promise<{ synced: number; skipped: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIST_TIMEOUT_MS);

  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `Bearer ${gistPat}`,
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      files?: Record<string, { content: string } | null>;
    };
    const file = data.files?.[GIST_FILE];
    if (!file?.content) return { synced: 0, skipped: 0 };

    const sync = JSON.parse(file.content) as GistSyncData;
    const readIds = sync.read ?? [];

    let synced = 0;
    let skipped = 0;

    for (const articleId of readIds) {
      // articles テーブルに存在しない場合はスキップ（期限切れ削除済みの可能性）
      const exists = q.articleExists.get({ $id: articleId });
      if (!exists) { skipped++; continue; }

      // 既に read_history に登録済みの場合は重複挿入しない
      const already = q.countReadByArticle.get({ $article_id: articleId });
      if (already && already.count > 0) { skipped++; continue; }

      q.insertReadHistory.run({ $article_id: articleId, $feedback: "read" });
      synced++;
    }

    return { synced, skipped };
  } finally {
    clearTimeout(timer);
  }
}
