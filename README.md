# OpenCode 履歴ビューワー

ローカルで動作する OpenCode 履歴ビューワーです。
`~/.local/share/opencode/opencode.db` を読み取り専用で開き、過去のセッションを
全文検索・時系列タイムライン・詳細再現・統計で振り返ることができます。

- ランタイム依存ゼロ（Node 24+ の `node:sqlite` のみ使用。devDependencies はビルド・検証用）
- DB は `readOnly` で開くため履歴を壊しません
- 巨大な `event` テーブルは参照しません（`session` / `message` / `part` のみ）

## 必要条件

- Node.js 24 以上（`node --version` で確認）
- 初回のみ `npm install`（TypeScript / esbuild / highlight.js / Biome は開発用依存）

## 起動

```sh
npm install
npm start        # ビルド後に http://localhost:8083 を開く
```

ポート変更・DB パス変更:

```sh
PORT=3000 npm start
OPENCODE_DB=/path/to/opencode.db npm start
```

開発（自動リロード）:

```sh
npm run dev
```

## 開発

```sh
npm run check      # Biome + tsc --noEmit + 単体テスト
npm test           # node:test による単体テストのみ
npm run build      # フロントバンドル (public/dist) とサーバー (dist) を生成
```

- UI 文言は英語。本文の Markdown 描画は marked（MIT、GFM）を使用。コードブロックのハイライトは highlight.js（BSD-3-Clause）を使用
- 構成: `src/server.ts`（API）・`src/db.ts`（SQLite 層）・`src/client/`（UI）・`src/shared/`（純粋関数）・`test/`（単体テスト）
- ライセンスがいずれも permissive なもののみ使用: TypeScript（Apache-2.0）、esbuild（MIT）、highlight.js（BSD-3-Clause）、marked（MIT）、@types/node（MIT）、Biome（MIT）

## 機能

- **セッション**: タイトル・ディレクトリ・プロジェクトで絞り込み、更新順に一覧表示。選択すると当時の会話・ツール呼び出し・推論過程を時系列で再現
- **検索**: 本文・ツール入出力・推論テキストから全文検索（スペース区切りで AND）。結果クリックで該当セッションへジャンプしハイライト表示
- **タイムライン**: 日別にセッション数・発言数・コストを集計。日をクリックするとその日のセッションに絞り込み
- **統計**: 総セッション数・メッセージ数・コスト・トークン、プロジェクト別・モデル別集計、ツール利用 TOP

## API

- `GET /api/health`
- `GET /api/projects`
- `GET /api/sessions?limit=&offset=&q=&project=&from=&to=&sort=updated|created`
- `GET /api/session/:id`
- `GET /api/search?q=&limit=&offset=&project=`
- `GET /api/timeline?project=`
- `GET /api/stats`

## 注意

- タイムスタンプはミリ秒 epoch。表示は `en-US` ロケールで行います
- ツール出力が巨大な場合は表示・API ともに先頭部分のみ返します
