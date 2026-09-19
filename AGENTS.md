# AGENTS.md

## 構成
- `src/server.ts` … API（標準 `node:http` のみ、Express 不使用）。esbuild で `dist/` にバンドルして実行
- `src/db.ts` … SQLite アクセス層（全クエリはここ）
- `src/client/` … UI（`app.ts` + `highlight.ts`）。esbuild で `public/dist/` にバンドル
- `src/shared/` … DOM 非依存の純粋関数（`format.ts` 整形系＋`nav.ts` ナビ判定）。`test/` から直接 import される
- `public/` … `index.html` + `style.css`（手書き）
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
- タイムスタンプは ms epoch。タイムラインの日別集計はサーバーローカル日付でバケット化（SQL 側で `date(...,'localtime')` 集計し、全行を JS に載せない）

## SQLite の落とし穴
- `node:sqlite` のバインドはスプレッドのみ: `.all(...params)`。配列渡し `.all(arr)` は `Unknown named parameter '0'` で失敗する
- `part.data` / `message.data` は JSON 文字列。`json_extract(data, '$.type')` で絞り込み、`JSON.parse` は `parseJsonSafe` 経由で行う
- `substr(p.data,1,N)` を `JSON.parse` すると切断位置で壊れる。断片取得は `json_extract`＋`substr`（例: `substr(json_extract(p.data,'$.text'),1,200)`）で行う
- 一覧の per-session 取得に全体 `ORDER BY`＋`LIMIT` を使わない（先頭セッションに枠を奪われる＋低速）。`session_id` 索引の効く window 関数で2発（user 先頭＋全体先頭）にバッチ化する。N+1 分割は 50件で約800ms のため避ける
- `session.model` も JSON 文字列（`{"id","providerID","variant"}`。旧形式はプレーン文字列）。表示は `parseModel` 経由にし、生 JSON を出さない
- モデル別のコスト集計は message 単位で行う（`session.model` は最終選択モデルのため、マルチモデルセッションの按分に使うと誤集計になる）
- LIKE 検索は `escapeLike`（`%_\\`）＋ `ESCAPE '\\'` 必須
- 巨大出力を返さない caps を維持する: 本文 8000・tool 入力 4000/出力 8000・検索は `json_extract` 抜き出し＋`substr`（text 8000・input 4000・output/meta 8000・files 2000）。1165発言セッションで約5MBになる

## 検証（Biome + tsc + node:test）
- `npm run check` が正（Biome＋`tsc --noEmit`＋`node --test test/*.test.ts`）。修正は `npm run format`
- Node 24 は `--test` のディレクトリ指定不可のため glob 形式を維持する（CI は 24/26 マトリクス）。`engines >= 24` の下限保証を崩さない
- 日付表示のテストは固定 epoch で assert しない（CI は UTC で日付がずれる）。`new Date(2026, 8, 18, 12, 0)` のようにローカル時刻で組み立てる
- テストに個人のパスをハードコードしない（public リポジトリのため）。ホーム配下は `os.homedir()` から組み立てる
- `biome.json` はスペースインデント（既存コードに合わせている。tab に変えない）
- `tsconfig` の `types: ["node"]` は消さない（外すと `node:sqlite` 等の型解決が壊れる）
- TS は消去可能構文のみ（`erasableSyntaxOnly`）。import は `.ts` 拡張子付きで書く
- `test/` から import されるモジュールはトップレベルで DOM に触らない（`node --test` が TS を直接実行するため）
- push/PR 時に `.github/workflows/check.yml` が `npm run check`＋`npm run build` を実行する
- 新規 API の数値・ID パラメータは `clampInt` / `clampMs` / `isValidId` で正規化する（素の `Number()` は NaN・負数を通し SQLite エラーや 500 の元になる）
- 日本語クエリは必ず URL エンコードする（素の `curl "...?q=日本語&limit=3"` はシェルが `&` を解釈して壊れる）。`curl -G --data-urlencode "q=..."` を使う
- API: `/api/health` `/api/projects` `/api/sessions` `/api/session/:id` `/api/search` `/api/timeline` `/api/stats`
- 静的配信の SPA フォールバック（`index.html`）とパストラバーサルガード（`resolveStaticPath`）は残す。素朴な `startsWith(PUBLIC_DIR)` は sibling ディレクトリで突破されるため sep 付き照合が必須

## UI（`public/`）
- UI 文言は英語に統一（DB 由来のセッション内容を除く）。数値表示はコンパクト表記（`fmtCount`: k/M/B）。正確値は `title` 属性に `fmtExact`（`en-US` 3 桁区切り）で保持する
- セッション詳細の構造は `.turn`（1往復）＞ `.msg` ＞ 回答カード（`.part.answer`）＋作業ログ（`details.worklog`）。回答なし assistant は `<details class="msg work-only">`（msg-head 一体型 summary）。`.msg` はやり取りナビ（`buildNav`＋`resolveNavIndex`）のアンカーなので剥がさない。構造変更時はスクロール同期（`toggle`・`resize` での再同期）を確認する
- シンタックスハイライトは highlight.js（必要言語のみ `highlight.ts` で登録＋esbuild バンドル）。Markdown 描画は marked（GFM）＋自前の安全化（生 HTML 無効化・URL スキーム制限＋相対 URL のリンク化拒否・コード描画は `highlightTokens`）。外部ライブラリ・CDN の利用可
- タブのスライド式インジケーターは JS で位置計算（`moveTabIndicator`）＋ CSS transition。`resize` と `document.fonts.ready` でも再計算する
- ページ送りボタンは対象ページがない場合 `disabled` にする（セッション一覧・検索結果とも）。`button:disabled` のスタイルは `style.css` に定義済み
- ツール詳細・作業ログ等の `<details>` は閉状態で描画する（巨大セッションの描画コスト対策）。`open` を付けない
