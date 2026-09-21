import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDb } from "./db.ts";
import { createHandler } from "./handler.ts";
import { parsePort } from "./shared/validate.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = parsePort(process.env.PORT);
const DB_PATH = defaultDbPath();
// リクエスト毎の getpwuid を避けるため起動時に確定する
const HOME = os.homedir();

let db: DatabaseSync;
try {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[opencode-viewer] DB が見つかりません: ${DB_PATH}`);
    console.error(`環境変数 OPENCODE_DB でパスを指定できます。`);
    process.exit(1);
  }
  db = openDb(DB_PATH);
  console.log(`[opencode-viewer] DB: ${DB_PATH} (read-only)`);
} catch (e) {
  console.error(
    `[opencode-viewer] DB オープン失敗: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}

const server = http.createServer(
  createHandler(db, { publicDir: PUBLIC_DIR, home: HOME }),
);

// LAN 公開を避けるため loopback のみにバインドする（履歴 DB は機密情報を含みうる）
const startedAt = new Date();
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[opencode-viewer] 開始: ${startedAt.toLocaleString("ja-JP")} (${startedAt.toISOString()})`,
  );
  console.log(`[opencode-viewer] http://127.0.0.1:${PORT} で起動しました`);
  console.log(`[opencode-viewer] 終了は Ctrl+C`);
});

function shutdown(signal: string): void {
  const uptimeMin = Math.max(
    0,
    Math.round((Date.now() - startedAt.getTime()) / 60000),
  );
  console.log(
    `[opencode-viewer] ${signal} を受信したため終了します（稼働約${uptimeMin}分）`,
  );
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  // close が掛かったままの場合は 3 秒で強制終了（二重起動防止）
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
