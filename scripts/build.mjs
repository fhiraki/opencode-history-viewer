// フロントバンドル (public/dist) とサーバー (dist) を esbuild で生成する。
// 使い方: node scripts/build.mjs
import { rmSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { clientConfig, serverConfig } from "./esbuild.config.mjs";

// CWD ではなくこのファイルの位置を基準にする（別ディレクトリから
// `node /path/to/scripts/build.mjs` を実行しても、外のプロジェクトの成果物を消さない）
const ROOT = path.join(import.meta.dirname, "..");

// stale 成果物を除去してからビルドする
rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
rmSync(path.join(ROOT, "public", "dist"), { recursive: true, force: true });

// entryPoints / outdir は esbuild.config.mjs で相対パスのままなので、
// 同じ ROOT 基準で解決するため absWorkingDir を渡す
// esbuild.config.mjs の export はリテラルが widen されたままなので、
// 渡し境界で any を噛ませる（scripts/dev.mjs と同方針。tsc の checkJs 対象に
// 入れるための前提）
/** @type {any} */
const clientOptions = { ...clientConfig, absWorkingDir: ROOT };
/** @type {any} */
const serverOptions = { ...serverConfig, absWorkingDir: ROOT };
const client = await esbuild.context(clientOptions);
const server = await esbuild.context(serverOptions);

await client.rebuild();
await server.rebuild();
await client.dispose();
await server.dispose();
