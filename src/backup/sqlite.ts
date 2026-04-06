/**
 * SQLite バックアップスクリプト
 *
 * 用途: 週次（毎週日曜）にローカル SQLite を gzip 圧縮して
 *       バックアップ用 git リポジトリへ push する。
 *
 * 環境変数:
 *   DB_PATH         - SQLite ファイルパス（デフォルト: data/digest.db）
 *   BACKUP_REPO_DIR - バックアップ先の git リポジトリのローカルパス（必須）
 *
 * 事前準備:
 *   1. Private GitHub リポジトリ を作成（読了履歴・スコアを含むため）
 *   2. git clone <repo> $BACKUP_REPO_DIR
 *   3. Fine-grained PAT で contents:write のみ付与した認証情報を git に設定
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { $ } from "bun";

const ROOT_DIR = join(import.meta.dir, "../..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT_DIR, "data", "digest.db");
const BACKUP_REPO_DIR = process.env.BACKUP_REPO_DIR ?? "";

async function main(): Promise<void> {
  if (!BACKUP_REPO_DIR) {
    console.error("[backup] BACKUP_REPO_DIR is not set. Skipping.");
    process.exit(0);
  }

  if (!existsSync(DB_PATH)) {
    console.error(`[backup] DB not found: ${DB_PATH}`);
    process.exit(1);
  }

  if (!existsSync(BACKUP_REPO_DIR)) {
    console.error(`[backup] BACKUP_REPO_DIR not found: ${BACKUP_REPO_DIR}`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const backupDir = join(BACKUP_REPO_DIR, "backups");
  mkdirSync(backupDir, { recursive: true });

  const destGz = join(backupDir, `digest-${date}.db.gz`);

  // gzip 圧縮（SQLite の WAL が存在する場合も安全にコピー）
  console.log(`[backup] Compressing ${DB_PATH} → ${destGz}`);
  await $`gzip -c ${DB_PATH} > ${destGz}`;

  // 7日以上前のバックアップを削除（直近4週分を保持）
  await $`find ${backupDir} -name "*.db.gz" -mtime +28 -delete`.quiet();

  // git コミット & push
  await $`git -C ${BACKUP_REPO_DIR} add backups/`.quiet();

  const diffResult = await $`git -C ${BACKUP_REPO_DIR} diff --staged --quiet`.nothrow();
  if (diffResult.exitCode !== 0) {
    await $`git -C ${BACKUP_REPO_DIR} commit -m "backup: ${date}"`;
    await $`git -C ${BACKUP_REPO_DIR} push`;
    console.log(`[backup] Pushed backup for ${date}`);
  } else {
    console.log(`[backup] No changes to commit`);
  }
}

main().catch((err) => {
  console.error("[backup] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
