// フロントバンドル (public/dist) とサーバー (dist) を esbuild で生成する。
// 使い方: node scripts/build.mjs [--watch]
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

if (!watch) {
  // 通常ビルド時は stale 成果物を除去する（watch 中は dev サーバーの再起動を避けるため触らない）
  rmSync("dist", { recursive: true, force: true });
  rmSync("public/dist", { recursive: true, force: true });
}

const client = await esbuild.context({
  entryPoints: ["src/client/app.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "esm",
  outdir: "public/dist",
  entryNames: "app",
  loader: { ".css": "css" },
  logLevel: "info",
});

const server = await esbuild.context({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await client.watch();
  await server.watch();
  console.log("[build] watching src/ and public/ (dist excluded)");
} else {
  await client.rebuild();
  await server.rebuild();
  await client.dispose();
  await server.dispose();
}
