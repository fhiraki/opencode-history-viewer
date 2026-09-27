// @ts-check
// 開発用: esbuild watch とサーバー (`node --watch`) を1プロセスで管理する。
// 初回ビルド完了後にサーバーを起動するため、dist/ が無い新規クローンでも動く。
// 使い方: node scripts/dev.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { clientConfig, serverConfig } from "./esbuild.config.mjs";

// CWD ではなくこのファイルの位置を基準にする（scripts/build.mjs と同じ方針）。
// 別ディレクトリから実行しても、外のプロジェクトの dist/ を消したり
// 相対パスで解決したりしない
const ROOT = path.join(import.meta.dirname, "..");

// stale 成品物を除去してから watch を始める（build.mjs と同じ。
// この時点ではサーバー未起動なので安全）
rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
rmSync(path.join(ROOT, "public", "dist"), { recursive: true, force: true });

// esbuild.config.mjs は JS のためリテラル型が widen され、format / loader /
// logLevel が union のままで BuildOptions と代入互換にならない。設定の正本は
// あちら側なので、受け渡し境界でだけ any を受ける
/** @type {any} */
const clientOptions = { ...clientConfig, absWorkingDir: ROOT };
/** @type {any} */
const serverOptions = { ...serverConfig, absWorkingDir: ROOT };

const client = await esbuild.context(clientOptions);
const server = await esbuild.context(serverOptions);

// 先に dist/ を作ってからサーバーを起動する（node --watch は未生成ファイルで落ちるため）
await client.rebuild();
await server.rebuild();
await client.watch();
await server.watch();
console.log("[dev] initial build done, starting server (Ctrl+C to stop)");

const serverEntry = path.join(ROOT, "dist", "server.js");
const child = spawn(process.execPath, ["--watch", serverEntry], {
  stdio: "inherit",
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill("SIGTERM");
  await client.dispose();
  await server.dispose();
  process.exit(code);
}

child.on("exit", (code, signal) => {
  if (signal) {
    // シグナルで死んだ場合 code は null。成功（0）と見なさず非 0 で終了する
    shutdown(1);
    return;
  }
  shutdown(code ?? 0);
});
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// 親が予期せず落ちた場合（未処理例外等）でも node --watch の子が残り、
// ポート 8083 を掴んだまま次回起動が EADDRINUSE になるのを防ぐ同期フォールバック。
// "exit" フックでは非同期処理が完了しないため kill のみ行う
process.on("exit", () => {
  if (!shuttingDown) child.kill("SIGTERM");
});
