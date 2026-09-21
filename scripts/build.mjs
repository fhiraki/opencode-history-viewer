// フロントバンドル (public/dist) とサーバー (dist) を esbuild で生成する。
// 使い方: node scripts/build.mjs
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";
import { clientConfig, serverConfig } from "./esbuild.config.mjs";

// stale 成果物を除去してからビルドする
rmSync("dist", { recursive: true, force: true });
rmSync("public/dist", { recursive: true, force: true });

const client = await esbuild.context(clientConfig);
const server = await esbuild.context(serverConfig);

await client.rebuild();
await server.rebuild();
await client.dispose();
await server.dispose();
