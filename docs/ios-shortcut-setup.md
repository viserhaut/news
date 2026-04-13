# iOS Shortcut セットアップ手順 — X ブックマーク自動取込

X アプリの Share Sheet から起動し、ツイート URL を `pending/tweets.json` に追記する Shortcut の設定手順です。

---

## 概要

```
X アプリ → Share → Shortcut 起動
  → GitHub Contents API で pending/tweets.json を GET
  → Base64 デコード → URL を配列に追加
  → Base64 エンコード → PUT で更新
```

毎朝4時のパイプライン実行時に `pending/tweets.json` のURLが処理され、自動的に空になります。

---

## 前提条件

### GitHub PAT（Personal Access Token）の取得

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. **Generate new token** をクリック
3. 設定:
   - **Repository access**: `viserhaut/news` のみ
   - **Permissions**: `Contents` → `Read and write`
4. トークンをコピーして安全な場所に保存

---

## Shortcut の作成手順

### 1. 新規 Shortcut を作成

- **ショートカット** アプリ → `+` → 新規ショートカット
- 名前: `X → News Queue`

### 2. アクション一覧

以下のアクションを順番に追加します。

---

#### アクション 1: URL を受け取る（Share Sheet 入力）

- アクション: **「ショートカットの入力を受け取る」**
- 入力の種類: **URL**
- 用途: Share Sheet

---

#### アクション 2: 現在の pending/tweets.json を GET

- アクション: **「URLのコンテンツを取得」**
- URL:
  ```
  https://api.github.com/repos/viserhaut/news/contents/pending/tweets.json
  ```
- メソッド: **GET**
- ヘッダー:
  | キー | 値 |
  |---|---|
  | `Authorization` | `Bearer <YOUR_GITHUB_PAT>` |
  | `Accept` | `application/vnd.github+json` |
  | `X-GitHub-Api-Version` | `2022-11-28` |
- 変数名: `GithubResponse`（「結果を変数に設定」）

---

#### アクション 3: content（Base64）と sha を取り出す

- アクション: **「辞書の値を取得」**（2回）
  1. キー `content` → 変数名: `B64Content`
  2. キー `sha` → 変数名: `FileSha`
- 入力: `GithubResponse`

---

#### アクション 4: Base64 デコード

- アクション: **「テキストをデコード」**
- エンコード: **Base64**
- 入力: `B64Content`
- 変数名: `JsonText`

> **注意**: GitHub API が返す `content` には改行(`\n`)が含まれるため、デコード前に「テキストを置換」で `\n` → `（空白）` に置換してください。

---

#### アクション 5: JSON をパースして URL を追加

- アクション: **「辞書の値を取得」** → キー `urls` → 変数名: `UrlList`
- 入力: `JsonText`

- アクション: **「リストに追加」**
- リスト: `UrlList`
- 追加する項目: **ショートカットの入力**（Step 1 で受け取った URL）
- 変数名: `UpdatedList`（上書き or 新変数）

---

#### アクション 6: 更新した JSON を作成

- アクション: **「辞書を作成」**
  - キー `urls` → 値 `UpdatedList`
- 変数名: `UpdatedJson`

- アクション: **「テキストを取得」**（辞書 → JSON 文字列化）
  - 入力: `UpdatedJson`
- 変数名: `UpdatedJsonText`

---

#### アクション 7: Base64 エンコード

- アクション: **「テキストをエンコード」**
- エンコード: **Base64**
- 入力: `UpdatedJsonText`
- 変数名: `UpdatedB64`

---

#### アクション 8: GitHub Contents API で PUT

- アクション: **「URLのコンテンツを取得」**
- URL:
  ```
  https://api.github.com/repos/viserhaut/news/contents/pending/tweets.json
  ```
- メソッド: **PUT**
- ヘッダー:
  | キー | 値 |
  |---|---|
  | `Authorization` | `Bearer <YOUR_GITHUB_PAT>` |
  | `Accept` | `application/vnd.github+json` |
  | `Content-Type` | `application/json` |
  | `X-GitHub-Api-Version` | `2022-11-28` |
- ボディ（JSON）:
  ```json
  {
    "message": "Add X bookmark",
    "content": "<UpdatedB64 変数>",
    "sha": "<FileSha 変数>"
  }
  ```

---

#### アクション 9: 完了通知（任意）

- アクション: **「通知を表示」**
- 本文: `X ブックマークをキューに追加しました`

---

## Share Sheet への登録

1. Shortcut を開く → 右上の `...` → **「Appに表示」**
2. **「Share Sheet」** を ON にする
3. X アプリで任意のツイートを開き、共有ボタン → `X → News Queue` を選択

---

## テスト手順

1. X アプリで任意のツイートを Share → `X → News Queue` を実行
2. GitHub リポジトリ `viserhaut/news` → `pending/tweets.json` を確認
   - URL が配列に追加されていれば成功
3. 翌朝（または手動で `bun run start`）パイプラインを実行
4. `pending/tweets.json` が `{"urls": []}` に戻っていることを確認
5. DB に `source_id = "x_bookmark"` のレコードが追加されていることを確認

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| PUT が 409 Conflict | `sha` が古い | GET → PUT の間に別の更新が入った。再実行する |
| PUT が 422 Unprocessable | Base64 に改行が含まれている | Step 4 の改行除去を確認 |
| PUT が 403 Forbidden | PAT のスコープ不足 | `Contents: Read and write` を確認 |
| ツイートが取り込まれない | XAI_API_KEY 未設定 or 残高不足 | `.env` を確認、[console.x.ai](https://console.x.ai/) で残高確認 |
