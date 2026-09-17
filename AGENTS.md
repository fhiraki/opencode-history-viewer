# AGENTS.md

## 構成
- `src/server.ts` … API（標準 `node:http` のみ、Express 不使用）。esbuild で `dist/` にバンドルして実行
- `src/db.ts` … SQLite アクセス層（全クエリはここ）
- `src/client/` … UI（`app.ts` + `highlight.ts`）。esbuild で `public/dist/` にバンドル
- `src/shared/` … DOM 非依存の純粋関数（整形系）。`test/` から直接 import される
- `public/` … `index.html` + `style.css`（手書き、CDN 不使用）
- `public/dist/` と `dist/` はビルド成果物で編集禁止。修正は必ず `src/` 側に行う

## コマンド
- Node >= 24 必須（`node:sqlite` の `DatabaseSync` を使用）
- `npm install` 必須。ランタイム依存はゼロ（全て devDeps をビルド時にバンドル）
- `npm start`（`prestart` で自動ビルド）/ `npm run dev`（esbuild watch＋`node --watch`）/ `npm run build`
- `PORT`（既定 8083）、`OPENCODE_DB` で DB パス上書き可

## DB ルール（厳守）
- 実 DB は必ず `new DatabaseSync(path, { readOnly: true })` で開く。書き込み・マイグレーション・VACUUM 禁止
- 既定パス: `~/.local/share/opencode/opencode.db`
- `event` テーブルは絶対に触らない（DB 約7GB のうち約5.6GB を占める）。`session` / `message` / `part` のみ使う
- タイムスタンプは ms epoch。タイムラインの日別集計はサーバーローカル日付でバケット化

## SQLite の落とし穴
- `node:sqlite` のバインドはスプレッドのみ: `.all(...params)`。配列渡し `.all(arr)` は `Unknown named parameter '0'` で失敗する
- `part.data` / `message.data` は JSON 文字列。`json_extract(data, '$.type')` で絞り込み、`JSON.parse` は `parseJsonSafe` 経由で行う
- `session.model` も JSON 文字列（`{"id","providerID","variant"}`。旧形式はプレーン文字列）。表示は `parseModel` 経由にし、生 JSON を出さない
- モデル別のコスト集計は message 単位で行う（`session.model` は最終選択モデルのため、マルチモデルセッションの按分に使うと誤集計になる）
- LIKE 検索は `escapeLike`（`%_\\`）＋ `ESCAPE '\\'` 必須
- 巨大出力を返さない caps を維持する: 本文 8000・tool 入力 4000/出力 8000・検索用 `substr(p.data,1,12000)`。617発言セッションで既に約1.7MBになる

## 検証（Biome + tsc + node:test）
- `npm run check` が正（Biome＋`tsc --noEmit`＋`node --test`）。修正は `npm run format`
- `biome.json` はスペースインデント（既存コードに合わせている。tab に変えない）
- `tsconfig` の `types: ["node"]` は消さない（外すと `node:sqlite` 等の型解決が壊れる）
- TS は消去可能構文のみ（`erasableSyntaxOnly`）。import は `.ts` 拡張子付きで書く
- `test/` から import されるモジュールはトップレベルで DOM に触らない（`node --test` が TS を直接実行するため）
- push/PR 時に `.github/workflows/check.yml` が `npm run check`＋`npm run build` を実行する
- 日本語クエリは必ず URL エンコードする（素の `curl "...?q=日本語&limit=3"` はシェルが `&` を解釈して壊れる）。`curl -G --data-urlencode "q=..."` を使う
- API: `/api/health` `/api/projects` `/api/sessions` `/api/session/:id` `/api/search` `/api/timeline` `/api/stats`
- 静的配信の SPA フォールバック（`index.html`）とパストラバーサルガード（`startsWith(PUBLIC_DIR)`）は残す

## UI（`public/`）
- UI 文言は英語に統一（DB 由来のセッション内容を除く）。数値表示はコンパクト表記（`fmtCount`: k/M/B）。正確値は `title` 属性に `fmtExact`（`en-US` 3 桁区切り）で保持する
- CDN 禁止（オフライン動作）。シンタックスハイライトは highlight.js（必要言語のみ `highlight.ts` で登録＋esbuild バンドル）のみで行い、別ライブラリを追加しない
- タブのスライド式インジケーターは JS で位置計算（`moveTabIndicator`）＋ CSS transition。`resize` と `document.fonts.ready` でも再計算する
- ページ送りボタンは対象ページがない場合 `disabled` にする（セッション一覧・検索結果とも）。`button:disabled` のスタイルは `style.css` に定義済み
