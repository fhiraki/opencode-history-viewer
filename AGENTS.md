# AGENTS.md

## 構成
- `src/server.js` … エントリポイント（標準 `node:http` のみ、Express 不使用）
- `src/db.js` … SQLite アクセス層（全クエリはここ）
- `public/` … ビルド不要の静的 UI（`index.html` + `app.js` + `style.css`、CDN 不使用）

## コマンド
- Node >= 22.5 必須（`node:sqlite` の `DatabaseSync` を使用）
- ランタイムは依存ゼロ（`npm start` に install 不要）。Biome は devDeps のみなので lint には `npm install` が必要
- `npm start`（本番）/ `npm run dev`（`node --watch`）
- `PORT`（既定 8083）、`OPENCODE_DB` で DB パス上書き可

## DB ルール（厳守）
- 実 DB は必ず `new DatabaseSync(path, { readOnly: true })` で開く。書き込み・マイグレーション・VACUUM 禁止
- 既定パス: `~/.local/share/opencode/opencode.db`
- `event` テーブルは絶対に触らない（DB 約7GB のうち約5.6GB を占める）。`session` / `message` / `part` のみ使う
- タイムスタンプは ms epoch。タイムラインの日別集計はサーバーローカル日付でバケット化

## SQLite の落とし穴
- `node:sqlite` のバインドはスプレッドのみ: `.all(...params)`。配列渡し `.all(arr)` は `Unknown named parameter '0'` で失敗する
- `part.data` / `message.data` は JSON 文字列。`json_extract(data, '$.type')` で絞り込み、`JSON.parse` は `parseJsonSafe` 経由で行う
- LIKE 検索は `escapeLike`（`%_\\`）＋ `ESCAPE '\\'` 必須
- 巨大出力を返さない caps を維持する: 本文 8000・tool 入力 4000/出力 8000・検索用 `substr(p.data,1,12000)`。617発言セッションで既に約1.7MBになる

## 検証（Biome + node --check）
- `npm run check` が正（Biome チェック＋`node --check` 3ファイル）。修正は `npm run format`
- `biome.json` はスペースインデント（既存コードに合わせている。tab に変えない）
- push/PR 時に `.github/workflows/check.yml` が `npm run check` を実行する
- 日本語クエリは必ず URL エンコードする（素の `curl "...?q=日本語&limit=3"` はシェルが `&` を解釈して壊れる）。`curl -G --data-urlencode "q=..."` を使う
- API: `/api/health` `/api/sessions` `/api/session/:id` `/api/search` `/api/timeline` `/api/stats`
- 静的配信の SPA フォールバック（`index.html`）とパストラバーサルガード（`startsWith(PUBLIC_DIR)`）は残す
