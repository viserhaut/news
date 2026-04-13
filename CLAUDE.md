# news — AI News Digest Pipeline

## Overview
Bun + TypeScript + SQLite パイプライン。launchd で毎朝4時に自動実行し、
RSS を収集・AI要約・スコアリングして GitHub Pages に静的 HTML を配信する。

## Commands
- `bun run typecheck` — 型チェック（変更後は必ず実行）
- `bun run start`    — パイプライン手動実行
- `bun run generate` — docs/index.html のみ再生成

## Gotchas（コードを読んでも分かりにくい非自明な挙動）
- bun:sqlite のプレースホルダは `$name` 形式のみ（`:name` は動作しない）
- Claude CLI 呼び出しは stdin 経由（コマンドライン引数渡しはインジェクションリスクあり）
- launchd 経由だと `$PATH` が最小限になり `claude` コマンドが見つからない
- fast-xml-parser でエンティティ展開制限を緩めている（デフォルト値では一部 RSS がエラーになる）

## Security（既存実装の意図を壊さないこと）
- HTML 出力は必ず `esc()` 関数でエスケープ（XSS 防止）
- OGP 画像 URL は `safeUrl()` 関数を通す（SSRF 防止）
- RSS 本文はプロンプトに渡す前に `JSON.stringify` でエスケープ（プロンプトインジェクション対策）

## Input Files（直接編集可）
- `pending/tweets.json` は **入力ファイル**（生成物でない）
  - iOS Shortcut が GitHub Contents API 経由でツイート URL を追記する
  - パイプライン実行後に自動クリアされる（`{"urls": []}` に戻る）
  - `.gitignore` に追加しない

## Generated Files（絶対に直接編集しないこと）
- `docs/index.html` は **生成物** であり直接編集禁止
  - 機能追加・修正はすべて `src/generate/html.ts` に実装し `bun run generate` で再生成する
  - PR での競合解消時も `docs/index.html` を直接編集せず、`html.ts` を修正して `bun run generate` で解決する
  - 競合解消の手順: `git checkout origin/main -- docs/index.html` → `bun run generate` → `git add docs/index.html`

## Workflow
- IMPORTANT: `main` への直接プッシュ禁止。必ずブランチを切って PR を出す
- ブランチ名: `feature/<機能名>` または `fix/<内容>`
- IMPORTANT: PR 作成前に `bun run typecheck` が通ることを確認する
- PR マージ順序が依存する場合はコンフリクトを必ず解消してからマージする

## 変更禁止
- `.env`, `.env.example` — シークレットが含まれる
- `launchd/` — macOS スケジューラ設定。ローカル環境依存
- `scripts/run.sh` — 本番デプロイスクリプト。人間が管理
- `.gitleaks.toml` — セキュリティ設定
