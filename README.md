# opencode-viewer — OpenCode History Viewer

[English](#english) | [日本語](#日本語)

<a id="english"></a>
## English

A local-only web viewer for your OpenCode history.

It opens `~/.local/share/opencode/opencode.db` in **read-only** mode and lets you browse past sessions with full-text search, a daily timeline, session replay, and usage stats.

- Zero runtime dependencies (only Node 24+ built-in `node:sqlite`; other packages are build/dev-only and bundled with esbuild)
- Read-only access to the DB — your history is never modified
- Never touches the huge `event` table (uses `session` / `message` / `part` only)
- Binds to loopback (`127.0.0.1`) only, so your history is not exposed to the LAN

### Requirements

- Node.js >= 24 (`node --version`)
- An existing OpenCode database (default: `~/.local/share/opencode/opencode.db`)
- `npm install` on first setup (TypeScript / esbuild / marked / highlight.js / Biome are dev-only)

### Install & Run

```sh
git clone <this-repo-url>
cd opencode-viewer
npm install
npm start        # builds, then open http://127.0.0.1:8083
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
| `OPENCODE_DB`| `~/.local/share/opencode/opencode.db`      | Path to OpenCode DB file |

Examples:

```sh
PORT=3000 npm start
OPENCODE_DB=/path/to/opencode.db npm start
```

If the DB file is missing, the server exits with an error and tells you to set `OPENCODE_DB`.

### Features

- **Sessions**: filter by title / directory / project, sorted by updated or created. Selecting a session replays the conversation, tool calls, and reasoning steps in chronological order.
- **Search**: full-text search over message bodies, tool inputs/outputs, and reasoning text (space-separated terms are ANDed). Click a result to jump to the session with the match highlighted.
- **Timeline**: per-day counts of sessions, messages, and cost. Click a day to filter the session list.
- **Stats**: totals for sessions / messages / cost / tokens, plus per-project, per-model, and top-tools breakdowns.

### API

| Method | Endpoint                                                      | Description                              |
| ------ | ------------------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/health`                                                 | Liveness check (`{ ok, db }`)            |
| `GET`  | `/api/projects`                                               | Project list                             |
| `GET`  | `/api/sessions?limit=&offset=&q=&project=&from=&to=&sort=`    | Session list (`sort=updated` \| `created`) |
| `GET`  | `/api/session/:id`                                            | Session detail (messages + parts)        |
| `GET`  | `/api/search?q=&limit=&offset=&project=`                      | Full-text search over parts              |
| `GET`  | `/api/timeline?project=`                                      | Daily aggregates                         |
| `GET`  | `/api/stats`                                                  | Global stats                             |

Static files are served from `public/` with an SPA fallback to `index.html`.

### Safety & Privacy Notes

- The DB is opened with `new DatabaseSync(path, { readOnly: true })`. No writes, migrations, or `VACUUM` are ever performed.
- The server listens on `127.0.0.1` only.
- Timestamps in the DB are millisecond epoch; daily buckets are computed in server-local time.
- Very large tool outputs are truncated in both API responses and the UI to keep huge sessions renderable.

### Development

```sh
npm run check      # Biome + tsc --noEmit + unit tests
npm test           # node:test unit tests only
npm run build      # build frontend (public/dist) and server (dist)
npm run format     # auto-fix with Biome
```

Layout:

- `src/server.ts` — HTTP API (plain `node:http`, no Express), bundled to `dist/` with esbuild
- `src/db.ts` — all SQLite access
- `src/client/` — UI (`app.ts` + `highlight.ts`), bundled to `public/dist/`
- `src/shared/` — DOM-free pure functions (formatting, navigation, validation), imported directly from `test/`
- `public/` — hand-written `index.html` + `style.css`
- `test/` — `node:test` unit tests

Dependencies are all permissive licenses only: TypeScript (Apache-2.0), esbuild (MIT), highlight.js (BSD-3-Clause), marked (MIT), @types/node (MIT), Biome (MIT). UI text is English; Markdown is rendered with marked (GFM) + custom sanitization, code blocks are highlighted with highlight.js.

### License

MIT (see `package.json`; runtime has no third-party dependencies — all libraries are build/dev-only and bundled).

---

<a id="日本語"></a>
## 日本語

OpenCode の履歴をローカルで振り返るための Web ビューワーです。

`~/.local/share/opencode/opencode.db` を**読み取り専用**で開き、過去セッションの全文検索・日別タイムライン・詳細再現・統計表示ができます。

- ランタイム依存ゼロ（Node 24+ 標準の `node:sqlite` のみ使用。その他のパッケージはビルド・検証用で esbuild によりバンドル）
- DB は `readOnly` で開くため履歴を壊しません
- 巨大な `event` テーブルには触りません（`session` / `message` / `part` のみ使用）
- ループバック（`127.0.0.1`）のみにバインドするため、履歴が LAN に公開されません

### 必要条件

- Node.js 24 以上（`node --version` で確認）
- OpenCode のデータベースが存在すること（既定: `~/.local/share/opencode/opencode.db`）
- 初回のみ `npm install` が必要（TypeScript / esbuild / marked / highlight.js / Biome は開発用依存）

### インストールと起動

```sh
git clone <this-repo-url>
cd opencode-viewer
npm install
npm start        # ビルド後に http://127.0.0.1:8083 を開く
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
| `OPENCODE_DB`  | `~/.local/share/opencode/opencode.db`        | OpenCode の DB ファイルパス |

例:

```sh
PORT=3000 npm start
OPENCODE_DB=/path/to/opencode.db npm start
```

DB ファイルが存在しない場合、サーバーはエラーを表示して終了します。その際は `OPENCODE_DB` でパスを指定してください。

### 機能

- **セッション**: タイトル・ディレクトリ・プロジェクトで絞り込み、更新順／作成順に一覧表示。選択すると当時の会話・ツール呼び出し・推論過程を時系列で再現します
- **検索**: 本文・ツール入出力・推論テキストから全文検索（スペース区切りは AND）。結果クリックで該当セッションへジャンプしハイライト表示します
- **タイムライン**: 日別にセッション数・発言数・コストを集計。日をクリックするとその日のセッションに絞り込めます
- **統計**: 総セッション数・メッセージ数・コスト・トークン、プロジェクト別・モデル別集計、ツール利用 TOP を表示します

### API

| メソッド | エンドポイント                                                | 説明                              |
| -------- | ------------------------------------------------------------- | --------------------------------- |
| `GET`    | `/api/health`                                                 | 生存確認（`{ ok, db }` を返す）   |
| `GET`    | `/api/projects`                                               | プロジェクト一覧                  |
| `GET`    | `/api/sessions?limit=&offset=&q=&project=&from=&to=&sort=`    | セッション一覧（`sort=updated` \| `created`） |
| `GET`    | `/api/session/:id`                                            | セッション詳細（messages + parts）|
| `GET`    | `/api/search?q=&limit=&offset=&project=`                      | part 全文検索                     |
| `GET`    | `/api/timeline?project=`                                      | 日別集計                          |
| `GET`    | `/api/stats`                                                  | 全体統計                          |

静的ファイルは `public/` から配信し、該当なしのパスは SPA フォールバックとして `index.html` を返します。

### 安全・プライバシーに関する注意

- DB は `new DatabaseSync(path, { readOnly: true })` で開きます。書き込み・マイグレーション・`VACUUM` は一切行いません
- サーバーは `127.0.0.1` のみにバインドします
- DB 内のタイムスタンプはミリ秒 epoch で、日別集計はサーバーのローカル日付でバケット化します
- 巨大なツール出力は API・UI ともに先頭部分のみ返すよう切り詰めます（巨大セッションでも描画できるようにするため）

### 開発

```sh
npm run check      # Biome + tsc --noEmit + 単体テスト
npm test           # node:test による単体テストのみ
npm run build      # フロント（public/dist）とサーバー（dist）を生成
npm run format     # Biome による自動修正
```

構成:

- `src/server.ts` … API（標準 `node:http` のみ、Express 不使用）。esbuild で `dist/` にバンドルして実行
- `src/db.ts` … SQLite アクセス層（全クエリはここ）
- `src/client/` … UI（`app.ts` + `highlight.ts`）。esbuild で `public/dist/` にバンドル
- `src/shared/` … DOM 非依存の純粋関数（整形・ナビゲーション・バリデーション）。`test/` から直接 import
- `public/` … 手書きの `index.html` + `style.css`
- `test/` … `node:test` による単体テスト

依存ライブラリはいずれも permissive ライセンスのみです: TypeScript（Apache-2.0）、esbuild（MIT）、highlight.js（BSD-3-Clause）、marked（MIT）、@types/node（MIT）、Biome（MIT）。UI 文言は英語、本文の Markdown 描画は marked（GFM）＋自前の安全化、コードブロックのハイライトは highlight.js を使用しています。

### ライセンス

MIT（`package.json` 参照。ランタイムに第三者依存はなく、すべてのライブラリはビルド・開発用途のみでバンドルされます）。
