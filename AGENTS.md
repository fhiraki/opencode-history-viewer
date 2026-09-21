# AGENTS.md

## 構成
- `src/server.ts` … プロセス起動（DB オープン・loopback 待受・終了処理）。esbuild で `dist/` にバンドルして実行
- `src/handler.ts` … HTTP ルーティング／ハンドラ（`createHandler`。テストから実 HTTP サーバーに載せて検証する）
- `src/db.ts` … SQLite アクセス層（全クエリはここ）
- `src/client/` … UI（`app.ts` + `highlight.ts`）。esbuild で `public/dist/` にバンドル
- `src/shared/` … DOM 非依存の純粋関数（`format.ts` 整形系＋`nav.ts` ナビ判定＋`validate.ts` 入力正規化）。`test/` から直接 import される
- `public/` … `index.html` + `style.css`（手書き）
- `scripts/` … `build.mjs`（本番ビルド）／`dev.mjs`（watch＋サーバー管理）／`esbuild.config.mjs`（共有設定）
- `public/dist/` と `dist/` はビルド成果物で編集禁止。修正は必ず `src/` 側に行う

## コマンド
- Node >= 24 必須（`node:sqlite` の `DatabaseSync` を使用）
- `npm install` 必須。ランタイム依存はゼロ。新規ライブラリは devDependencies に追加し、esbuild（`scripts/esbuild.config.mjs` の client/server）でバンドルする。`dependencies` には入れない
- `npm start`（`prestart` で自動ビルド）/ `npm run dev`（esbuild watch＋`node --watch`）/ `npm run build`
- `PORT`（既定 8083）、`OPENCODE_DB` で DB パス上書き可
- README は英日2部構成。機能や API を変えたら両方の記述を更新する

## DB ルール（厳守）
- 実 DB は必ず `new DatabaseSync(path, { readOnly: true })` で開く。書き込み・マイグレーション・VACUUM 禁止
- 既定パス: `~/.local/share/opencode/opencode.db`
- `event` テーブルは絶対に触らない（DB の大部分を占める。執筆時点で DB 約11GB）。`session` / `message` / `part` のみ使う
- タイムスタンプは ms epoch。タイムラインの日別集計はサーバーローカル日付でバケット化（SQL 側で `date(...,'localtime')` 集計し、全行を JS に載せない）
- `server.listen(PORT, "127.0.0.1")` とレスポンスの `SECURITY_HEADERS`（CSP 等）は維持する（履歴を LAN に出さない）
- `node:sqlite` は同期 API。重いクエリはイベントループを止めて他リクエストも待たせるため、全走査・全行 `json_extract` を避け、prefix 絞り込み（下記）と索引を使う

## SQLite の落とし穴
- `node:sqlite` のバインドはスプレッドのみ: `.all(...params)`。配列渡し `.all(arr)` は `Unknown named parameter '0'` で失敗する
- `part.data` / `message.data` は JSON 文字列。`json_extract(data, '$.type')` を巨大テーブルの全行に適用しない（下記の prefix 判定を先に使う）。JS 側の `JSON.parse` は `parseJsonSafe` 経由で行う
- `substr(p.data,1,N)` を `JSON.parse` すると切断位置で壊れる。断片取得は `json_extract`＋`substr`（例: `substr(json_extract(p.data,'$.text'),1,200)`）で行う
- 一覧の per-session 取得に全体 `ORDER BY`＋`LIMIT` を使わない（先頭セッションに枠を奪われる＋低速）。`session_id` 索引の効く window 関数で2発（user 先頭＋全体先頭）にバッチ化する。N+1 分割は 50件で約800ms のため避ける
- `session.model` も JSON 文字列（`{"id","providerID","variant"}`。旧形式はプレーン文字列）。表示は `parseModel` 経由にし、生 JSON を出さない
- モデル別のコスト集計は message 単位で行う（`session.model` は最終選択モデルのため、マルチモデルセッションの按分に使うと誤集計になる）
- LIKE 検索は `escapeLike`（`%_\\`）＋ `ESCAPE '\\'` 必須。生 JSON への LIKE は `type` 等のキー名に当たるため、prefilter の後に表示対象フィールド（`$.text` / tool の `$.title`・`$.state` / `$.files`）だけを照合する（prefilter は JSON エスケープ済み表記に合わせる）
- 一覧・検索の `ORDER BY` には同値対策で `id DESC` を第2キーに付ける（`time_updated`・`time_created` は重複し得る）
- 巨大 JSON を全行に `json_extract` しない。`part.data` は `{"type":...}` が先頭固定なので `substr(data,1,N)` の prefix 判定（prefix の substr は行全体を実体化しない）で絞り、文字列処理で取り出す。キー順が異なる非正規形だけ `json_extract` にフォールバックする（`getStats` の toolUsage）
- `message.data` の role は先頭付近（実測 最長 46B）。`substr(data,1,512) LIKE '%"role":"assistant"%'` で絞ってから `MATERIALIZED` CTE 内で `json_extract` 集計する（perModel は 0.5〜0.8 秒 → 0.2 秒）
- 検索は `COUNT(*) OVER ()` を取得 CTE に同居させ、全走査を1回にする（従来は COUNT と取得で2回）。offset 超過で 0 件のときだけ数え直して total を保証する
- 一覧プレビューは `substr(p.data,1,14) = '{"type":"text"'` を先頭に置き、tool 出力の JSON パースを避ける（実測 2.3 倍）
- 巨大出力を返さない caps を維持する: 本文 8000・tool 入力 4000/出力 8000・検索は `json_extract` 抜き出し＋`substr`（text 8000・input 4000・output/meta 8000・files 2000）。1165発言セッションで約5MBになる

## 検証（Biome + tsc + node:test）
- `npm run check` が正（Biome＋`tsc --noEmit`＋`node --test test/*.test.ts`）。修正は `npm run format`
- テストを絞る: `node --test test/db.test.ts` / `node --test --test-name-pattern="getStats" test/*.test.ts`
- Node 24 は `--test` のディレクトリ指定不可のため glob 形式を維持する（CI は 24/26 マトリクス）。`engines >= 24` の下限保証を崩さない
- 日付表示のテストは固定 epoch で assert しない（CI は UTC で日付がずれる）。`new Date(2026, 8, 18, 12, 0)` のようにローカル時刻で組み立てる
- テストに個人のパスをハードコードしない（public リポジトリのため）。ホーム配下は `os.homedir()` から組み立てる
- `biome.json` はスペースインデント（既存コードに合わせている。tab に変えない）
- `tsconfig` の `types: ["node"]` は消さない（外すと `node:sqlite` 等の型解決が壊れる）
- TS は消去可能構文のみ（`erasableSyntaxOnly`）。import は `.ts` 拡張子付きで書く
- `test/` から import されるモジュールはトップレベルで DOM に触らない（`node --test` が TS を直接実行するため）
- push/PR 時に `.github/workflows/check.yml` が `npm run check`＋`npm run build` を実行する
- `test/fixture.ts` は `:memory:` の共有フィクスチャ（`*.test.ts` ではないのでテスト実行対象外）。HTTP は `handler.test.ts` が一時ポートで実サーバーを立てて検証する（`parseQuery` は不正 URL で throw しないこと）
- 新規 API の数値・ID パラメータは `clampInt` / `clampMs` / `isValidId` で正規化する（素の `Number()` は NaN・負数を通し SQLite エラーや 500 の元になる）。`limit` は下限1
- 日本語クエリは必ず URL エンコードする（素の `curl "...?q=日本語&limit=3"` はシェルが `&` を解釈して壊れる）。`curl -G --data-urlencode "q=..."` を使う
- API: `/api/health` `/api/projects` `/api/sessions` `/api/session/:id` `/api/search` `/api/timeline` `/api/stats`
- 静的配信の SPA フォールバック（`index.html`）とパストラバーサルガード（`resolveStaticPath`）は残す。素朴な `startsWith(PUBLIC_DIR)` は sibling ディレクトリで突破されるため sep 付き照合が必須

## UI（`public/`）
- UI 文言は英語に統一（DB 由来のセッション内容を除く）。数値表示はコンパクト表記（`fmtCount`: k/M/B）。正確値は `title` 属性に `fmtExact`（`en-US` 3 桁区切り）で保持する
- セッション詳細の構造は `.turn`（1往復）＞ `.msg` ＞ 回答カード（`.part.answer`）＋作業ログ（`details.worklog`）。回答なし assistant は `<details class="msg work-only">`（msg-head 一体型 summary）。`.msg` はやり取りナビ（`buildNav`＋`resolveNavIndex`）のアンカーなので剥がさない。構造変更時はスクロール同期（`toggle`・`resize` での再同期）を確認する
- シンタックスハイライトは highlight.js（必要言語のみ `highlight.ts` で登録＋esbuild バンドル）。Markdown 描画は marked（GFM）＋自前の安全化（生 HTML 無効化・URL スキーム制限＋相対 URL のリンク化拒否・コード描画は `highlightTokens`）。外部 CDN は CSP（`default-src 'self'`）で遮断されるため使えない
- タブのスライド式インジケーターは JS で位置計算（`moveTabIndicator`）＋ CSS transition。`resize` と `document.fonts.ready` でも再計算する
- ページ送りボタンは対象ページがない場合 `disabled` にする（セッション一覧・検索結果とも）。`button:disabled` のスタイルは `style.css` に定義済み
- ツール詳細・作業ログ等の `<details>` は閉状態で描画する（巨大セッションの描画コスト対策）。`open` を付けない
- ツール入出力の highlight.js は描画時に一括実行しない。`.lazy-hl`＋`data-lang` のプレースホルダ（エスケープ済みテキスト）で描画し、`toggle` で `hydrateLazyHighlights` が開いた分だけハイライトする
- ナビのアンカー位置は `navOffsets`（コンテナ内容座標）にキャッシュし、`details` 開閉・`resize`・`fonts.ready` で無効化する。スクロール毎に全アンカーの `getBoundingClientRect` を測らない
- Stats は同一ページ表示中 `statsCache` を使う（Sessions の Reload で破棄）。タブ切替のたびに再取得しない
