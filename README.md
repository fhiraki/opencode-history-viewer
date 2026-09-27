# opencode-viewer — OpenCode History Viewer

[English](#english) | [日本語](#日本語)

<a id="english"></a>
## English

A local-only web viewer for your OpenCode history.

It opens the OpenCode database (default: `$XDG_DATA_HOME/opencode/opencode.db`; `~/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset) in **read-only** mode and lets you browse past sessions with full-text search, a daily timeline, session replay, and usage stats.

- Zero runtime dependencies (only Node 24+ built-in `node:sqlite`; other packages are build/dev-only and bundled with esbuild)
- Read-only access to the DB — your history is never modified
- Never touches the huge `event` table (uses `session` / `message` / `part` only)
- Binds to loopback (`127.0.0.1`) only, so your history is not exposed to the LAN

### Requirements

- Node.js >= 24 (`node --version`)
- An existing OpenCode database (default: `$XDG_DATA_HOME/opencode/opencode.db`; `~/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset)
- `npm install` on first setup (TypeScript / esbuild / marked / highlight.js / Biome are dev-only)

### Install & Run

```sh
git clone <this-repo-url>
cd opencode-viewer
npm install
npm start        # builds, then starts the server (the URL is printed in the log)
```

Open `http://127.0.0.1:8083` in your browser. Press `Ctrl+C` to stop.

Development with auto-reload:

```sh
npm run dev
```

### Configuration

| Env var      | Default                                    | Description              |
| ------------ | ------------------------------------------ | ------------------------ |
| `PORT`       | `8083`                                     | HTTP port to listen on   |
| `OPENCODE_DB`| `$XDG_DATA_HOME/opencode/opencode.db`      | Path to OpenCode DB file |

* When `XDG_DATA_HOME` is unset, the default is `~/.local/share/opencode/opencode.db`.

Examples:

```sh
PORT=3000 npm start
OPENCODE_DB=/path/to/opencode.db npm start
```

If the DB file is missing, the server exits with an error and tells you to set `OPENCODE_DB`.

### Features

- **Sessions**: filter by title / directory / project, sorted by updated or created. Selecting a session replays the conversation, tool calls, and reasoning steps in chronological order.
- **Search**: full-text search over message bodies, tool inputs/outputs, reasoning text, tool titles, and patch file lists (space-separated terms are ANDed). Click a result to jump to the session with the match highlighted.
- **Timeline**: per-day counts of sessions, messages, and cost. Click a day to filter the session list.
- **Stats**: totals for sessions / messages / cost / tokens, plus per-project, per-model, and top-tools breakdowns.

### API

| Method | Endpoint                                                      | Description                              |
| ------ | ------------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/health`                                                 | Liveness check (`{ ok }`)                |
| `GET`  | `/api/projects`                                               | Project list                             |
| `GET`  | `/api/sessions?limit=&offset=&q=&project=&from=&to=&sort=`    | Session list (`sort=updated` \| `created`) |
| `GET`  | `/api/session/:id`                                            | Session detail (messages + parts)        |
| `GET`  | `/api/search?q=&limit=&offset=&project=`                      | Full-text search over parts              |
| `GET`  | `/api/timeline?project=`                                      | Daily aggregates                         |
| `GET`  | `/api/stats`                                                  | Global stats                             |

Static files are served from `public/` under this delivery policy:

- A missing path **with** an extension returns `404` and is never SPA-fallbacked, so a forgotten build step (`/dist/app.js`) is not hidden behind a `200`. Only a missing path **without** an extension falls back to `index.html` (SPA routing).
- Only `GET` and `HEAD` are accepted; any other method returns `405` with `Allow: GET, HEAD`. `HEAD` answers with the same status and headers as `GET`, without a body.
- A file that exists but fails to read (permissions, I/O) returns `500` — it is never silently replaced by `index.html`.
- A request path whose real location (`realpath`) lands outside `public/` — e.g. through a symlink — returns `403`, including the `index.html` the SPA fallback serves.

### Safety & Privacy Notes

- The DB is opened with `new DatabaseSync(path, { readOnly: true })`. No writes, migrations, or `VACUUM` are ever performed.
- The server listens on `127.0.0.1` only, and every request must carry a loopback `Host` header. A non-loopback `Host` — or no `Host` at all, as sent by HTTP/1.0 — is rejected with `403` on every route (DNS rebinding protection, so the check fails closed).
- Timestamps in the DB are millisecond epoch; daily buckets are computed in server-local time.
- Very large tool outputs are truncated in both API responses and the UI to keep huge sessions renderable.

### Development

```sh
npm run check      # Biome + tsc --noEmit + unit tests
npm test           # node:test unit tests only
npm run build      # build frontend (public/dist) and server (dist)
npm run format     # auto-fix with Biome
```

Install scripts are governed by the top-level `allowScripts` field in `package.json`. The `esbuild` entry is name-only (not pinned as `esbuild@0.28.2`), so a `^0.28.2` → `0.29.x` bump does not silently drop its approval. npm lists packages whose install scripts have not been reviewed yet; approve them with:

```sh
npm approve-scripts --allow-scripts-pending           # list what is pending (read-only)
npm approve-scripts esbuild                           # pin to the installed version
npm approve-scripts --no-allow-scripts-pin esbuild    # name-only (allows any version)
```

Layout:

- `src/server.ts` — process entry point (DB open, loopback listen, shutdown), bundled to `dist/` with esbuild
- `src/handler.ts` — HTTP routing/handler (`createHandler`, tested over real HTTP)
- `src/db.ts` — all SQLite access
- `src/client/` — UI (`app.ts` + `highlight.ts`), bundled to `public/dist/`
- `src/shared/` — DOM-free pure functions (formatting, navigation, validation), imported directly from `test/`
- `public/` — hand-written `index.html` + `style.css`
- `test/` — `node:test` unit tests

Dependencies are all permissive licenses only: TypeScript (Apache-2.0), esbuild (MIT), highlight.js (BSD-3-Clause), marked (MIT), @types/node (MIT), Biome (MIT). UI text is English; Markdown is rendered with marked (GFM) + custom sanitization, code blocks are highlighted with highlight.js.

### License

MIT (see `LICENSE`; runtime has no third-party dependencies — all libraries are build/dev-only and bundled).

---

<a id="日本語"></a>
## 日本語

OpenCode の履歴をローカルで振り返るための Web ビューワーです。

OpenCode の DB（既定: `$XDG_DATA_HOME/opencode/opencode.db`、`XDG_DATA_HOME` 未設定時は `~/.local/share/opencode/opencode.db`）を**読み取り専用**で開き、過去セッションの全文検索・日別タイムライン・詳細再現・統計表示ができます。

- ランタイム依存ゼロ（Node 24+ 標準の `node:sqlite` のみ使用。その他のパッケージはビルド・検証用で esbuild によりバンドル）
- DB は `readOnly` で開くため履歴を壊しません
- 巨大な `event` テーブルには触りません（`session` / `message` / `part` のみ使用）
- ループバック（`127.0.0.1`）のみにバインドするため、履歴が LAN に公開されません

### 必要条件

- Node.js 24 以上（`node --version` で確認）
- OpenCode のデータベースが存在すること（既定: `$XDG_DATA_HOME/opencode/opencode.db`、`XDG_DATA_HOME` 未設定時は `~/.local/share/opencode/opencode.db`）
- 初回のみ `npm install` が必要（TypeScript / esbuild / marked / highlight.js / Biome は開発用依存）

### インストールと起動

```sh
git clone <this-repo-url>
cd opencode-viewer
npm install
npm start        # ビルド後にサーバーを起動（URL はログに出る）
```

ブラウザで `http://127.0.0.1:8083` を開きます。終了は `Ctrl+C` です。

開発時（自動リロード）:

```sh
npm run dev
```

### 設定

| 環境変数       | 既定値                                       | 説明                     |
| -------------- | -------------------------------------------- | ------------------------ |
| `PORT`         | `8083`                                       |待ち受ける HTTP ポート    |
| `OPENCODE_DB`  | `$XDG_DATA_HOME/opencode/opencode.db`        | OpenCode の DB ファイルパス |

* `XDG_DATA_HOME` 未設定時は `~/.local/share/opencode/opencode.db`。

例:

```sh
PORT=3000 npm start
OPENCODE_DB=/path/to/opencode.db npm start
```

DB ファイルが存在しない場合、サーバーはエラーを表示して終了します。その際は `OPENCODE_DB` でパスを指定してください。

### 機能

- **セッション**: タイトル・ディレクトリ・プロジェクトで絞り込み、更新順／作成順に一覧表示。選択すると当時の会話・ツール呼び出し・推論過程を時系列で再現します
- **検索**: 本文・ツール入出力・推論テキスト・ツールタイトル・パッチのファイル一覧から全文検索（スペース区切りは AND）。結果クリックで該当セッションへジャンプしハイライト表示します
- **タイムライン**: 日別にセッション数・発言数・コストを集計。日をクリックするとその日のセッションに絞り込めます
- **統計**: 総セッション数・メッセージ数・コスト・トークン、プロジェクト別・モデル別集計、ツール利用 TOP を表示します

### API

| メソッド | エンドポイント                                                | 説明                              |
| -------- | ------------------------------------------------------------- | --------------------------------- |
| `GET`    | `/api/health`                                                 | 生存確認（`{ ok }` を返す）       |
| `GET`    | `/api/projects`                                               | プロジェクト一覧                  |
| `GET`    | `/api/sessions?limit=&offset=&q=&project=&from=&to=&sort=`    | セッション一覧（`sort=updated` \| `created`） |
| `GET`    | `/api/session/:id`                                            | セッション詳細（messages + parts）|
| `GET`    | `/api/search?q=&limit=&offset=&project=`                      | part 全文検索                     |
| `GET`    | `/api/timeline?project=`                                      | 日別集計                          |
| `GET`    | `/api/stats`                                                  | 全体統計                          |

静的ファイルは `public/` から次の配信ポリシーで配信します。

- 拡張子**付き**の存在しないパスは `404` を返し、SPA フォールバックしません（`/dist/app.js` のビルド漏れを `200` で無言に隠さないため）。拡張子**なし**の未存在パスだけ `index.html` にフォールバックします（SPA ルーティング）。
- 受け付けるメソッドは `GET` / `HEAD` のみで、それ以外は `Allow: GET, HEAD` 付きの `405` を返します。`HEAD` は `GET` と同じステータス・ヘッダでボディだけを捨てます。
- 存在が確認できたファイルの read が失敗した場合（権限・I/O エラー）は `500` を返します（`index.html` の `200` に無言で化けません）。
- 実体（`realpath`）が `public/` の外を指す要求パス（symlink 経由等）は `403` を返します。SPA フォールバックが返す `index.html` も同じ検証に通します。

### 安全・プライバシーに関する注意

- DB は `new DatabaseSync(path, { readOnly: true })` で開きます。書き込み・マイグレーション・`VACUUM` は一切行いません
- サーバーは `127.0.0.1` のみにバインドします。あわせて全ルートで `Host` ヘッダがループバックであることを要求し、ループバックでない `Host`（および `Host` を持たない HTTP/1.0 の要求）は `403` で拒否します（DNS rebinding 対策。判定は fail-closed）
- DB 内のタイムスタンプはミリ秒 epoch で、日別集計はサーバーのローカル日付でバケット化します
- 巨大なツール出力は API・UI ともに先頭部分のみ返すよう切り詰めます（巨大セッションでも描画できるようにするため）

### 開発

```sh
npm run check      # Biome + tsc --noEmit + 単体テスト
npm test           # node:test による単体テストのみ
npm run build      # フロント（public/dist）とサーバー（dist）を生成
npm run format     # Biome による自動修正
```

install script の実行可否は `package.json` 直下の `allowScripts` で管理しています。`esbuild` は name-only（`esbuild@0.28.2` のようにピン留めしない）で登録しているため、`^0.28.2` から `0.29.x` に上がっても承認が外れません。未レビューのパッケージは install 時に通知されるので、次のコマンドで承認します。

```sh
npm approve-scripts --allow-scripts-pending           # 未承認の一覧（読み取り専用）
npm approve-scripts esbuild                           # インストール済みバージョンでピン留め
npm approve-scripts --no-allow-scripts-pin esbuild    # name-only（全バージョン許可）
```

構成:

- `src/server.ts` … プロセス起動（DB オープン・loopback 待受・終了処理）。esbuild で `dist/` にバンドルして実行
- `src/handler.ts` … HTTP ルーティング／ハンドラ（`createHandler`。実 HTTP でテストされる）
- `src/db.ts` … SQLite アクセス層（全クエリはここ）
- `src/client/` … UI（`app.ts` + `highlight.ts`）。esbuild で `public/dist/` にバンドル
- `src/shared/` … DOM 非依存の純粋関数（整形・ナビゲーション・バリデーション）。`test/` から直接 import
- `public/` … 手書きの `index.html` + `style.css`
- `test/` … `node:test` による単体テスト

依存ライブラリはいずれも permissive ライセンスのみです: TypeScript（Apache-2.0）、esbuild（MIT）、highlight.js（BSD-3-Clause）、marked（MIT）、@types/node（MIT）、Biome（MIT）。UI 文言は英語、本文の Markdown 描画は marked（GFM）＋自前の安全化、コードブロックのハイライトは highlight.js を使用しています。

### ライセンス

MIT（`LICENSE` 参照。ランタイムに第三者依存はなく、すべてのライブラリはビルド・開発用途のみでバンドルされます）。
