#!/bin/bash
# git pre-commit hook のインストールスクリプト
# 実行: bash scripts/install-hooks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="$PROJECT_DIR/.git/hooks"

# gitleaks のインストール確認
if ! command -v gitleaks &> /dev/null; then
  echo "[warn] gitleaks が見つかりません。インストールしてください:"
  echo "       brew install gitleaks"
  echo ""
  echo "インストール後に再度このスクリプトを実行してください。"
  exit 1
fi

# pre-commit hook を作成
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# gitleaks でシークレットの混入をチェック
if command -v gitleaks &> /dev/null; then
  gitleaks protect --staged --config .gitleaks.toml --redact
  if [ $? -ne 0 ]; then
    echo ""
    echo "[error] シークレットが検出されました。コミットを中止します。"
    echo "        誤検知の場合は .gitleaks.toml の allowlist に追加してください。"
    exit 1
  fi
fi
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "[ok] pre-commit hook をインストールしました: $HOOKS_DIR/pre-commit"
echo "[ok] gitleaks $(gitleaks version) が有効になりました"
