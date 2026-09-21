// 開発用: esbuild watch とサーバー (`node --watch`) を1プロセスで管理する。
// 初回ビルド完了後にサーバーを起動するため、dist/ が無い新規クローンでも動く。
// 使い方: node scripts/dev.mjs
import { spawn } from "node:child_process";
import * as esbuild from "esbuild";
import { clientConfig, serverConfig } from "./esbuild.config.mjs";

const client = await esbuild.context(clientConfig);
const server = await esbuild.context(serverConfig);

// 先に dist/ を作ってからサーバーを起動する（node --watch は未生成ファイルで落ちるため）
await client.rebuild();
await server.rebuild();
await client.watch();
await server.watch();
console.log("[dev] initial build done, starting server (Ctrl+C to stop)");

const child = spawn(process.execPath, ["--watch", "dist/server.js"], {
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

child.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
