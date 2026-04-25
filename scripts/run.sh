#!/bin/bash
# ニュースダイジェスト パイプライン実行スクリプト
# launchd から呼び出される。パイプライン実行後に docs/index.html を git push する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# NVM / nodenv などで管理された bun を PATH に含める
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" --no-use
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# claude CLI: NVM 管理の Node.js バイナリを PATH に追加
if [ -d "$NVM_DIR/versions/node" ]; then
  NODE_BIN=$(ls -d "$NVM_DIR/versions/node"/*/bin 2>/dev/null | tail -1)
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

# ログディレクトリ
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-$(date +%Y-%m-%d).log"

exec >> "$LOG_FILE" 2>&1

echo "=== $(date '+%Y-%m-%d %H:%M:%S') pipeline start ==="

cd "$PROJECT_DIR"

# 必ず main ブランチで実行（作業ブランチに切り替わったまま実行されると push が失敗する）
git checkout main
git pull --rebase origin main || echo "[warn] git pull --rebase skipped (conflict or no network)"

# パイプライン実行（RSS fetch → 要約 → HTML 生成 → Slack 通知）
bun run src/index.ts

# docs/index.html を git push（変更がある場合のみ）
git add docs/index.html
if ! git diff --staged --quiet; then
  git commit -m "chore: update digest $(date +%Y-%m-%d)"
  git push
  echo "[deploy] docs/index.html pushed"
else
  echo "[deploy] No changes to push"
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') pipeline done ==="
