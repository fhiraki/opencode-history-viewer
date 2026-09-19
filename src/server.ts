import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  defaultDbPath,
  getSessionDetail,
  getStats,
  getTimeline,
  listProjects,
  listSessions,
  openDb,
  searchParts,
} from "./db.ts";
import {
  clampInt,
  clampMs,
  isValidId,
  parsePort,
  parseQuery,
  resolveStaticPath,
} from "./shared/validate.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = parsePort(process.env.PORT);
const DB_PATH = defaultDbPath();

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, obj: unknown, status = 200): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function sendFile(
  res: http.ServerResponse,
  filePath: string,
  isHtmlFallback = false,
): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 競合で消えた場合は SPA フォールバック、それ以外は 404
      if (isHtmlFallback) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"), true);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
}

/** 静的ファイルの解決（テスト可能な shared 実装への薄いラッパー） */
function resolveStaticPathForPublic(
  pathname: string,
): string | null | "forbidden" {
  return resolveStaticPath(pathname, PUBLIC_DIR);
}

const server = http.createServer((req, res) => {
  const { pathname, params } = parseQuery(req.url);

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, { ok: true, db: DB_PATH });
    }
    if (req.method === "GET" && pathname === "/api/projects") {
      return sendJson(res, { projects: listProjects(db) });
    }
    if (req.method === "GET" && pathname === "/api/sessions") {
      const result = listSessions(db, {
        limit: clampInt(params.get("limit"), 50, 200),
        offset: clampInt(params.get("offset"), 0, 1_000_000),
        q: (params.get("q") || "").slice(0, 500),
        project: (params.get("project") || "").slice(0, 128),
        from: clampMs(params.get("from")),
        to: clampMs(params.get("to")),
        sort: params.get("sort") || "updated",
      });
      return sendJson(res, { ...result, home: os.homedir() });
    }
    if (req.method === "GET" && pathname.startsWith("/api/session/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/api/session/".length));
      } catch {
        return sendJson(res, { error: "bad id" }, 400);
      }
      if (!isValidId(id)) return sendJson(res, { error: "bad id" }, 400);
      const detail = getSessionDetail(db, id);
      if (!detail) return sendJson(res, { error: "not found" }, 404);
      return sendJson(res, detail);
    }
    if (req.method === "GET" && pathname === "/api/search") {
      const result = searchParts(db, {
        q: (params.get("q") || "").slice(0, 500),
        limit: clampInt(params.get("limit"), 50, 200),
        offset: clampInt(params.get("offset"), 0, 1_000_000),
        project: (params.get("project") || "").slice(0, 128),
      });
      return sendJson(res, { ...result, home: os.homedir() });
    }
    if (req.method === "GET" && pathname === "/api/timeline") {
      return sendJson(res, {
        days: getTimeline(db, {
          project: (params.get("project") || "").slice(0, 128),
        }),
      });
    }
    if (req.method === "GET" && pathname === "/api/stats") {
      return sendJson(res, getStats(db));
    }

    // 静的ファイル
    if (req.method === "GET") {
      const resolved = resolveStaticPathForPublic(pathname);
      if (resolved === null) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      if (resolved === "forbidden") {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(resolved);
      } catch {
        stat = null;
      }
      if (stat?.isFile()) {
        return sendFile(res, resolved);
      }
      // SPA フォールバック
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (e) {
    console.error(`[api] ${pathname} error:`, e);
    // 内部詳細（SQLite エラー等）をクライアントに漏らさない
    sendJson(res, { error: "internal error" }, 500);
  }
});

// LAN 公開を避けるため loopback のみにバインドする（履歴 DB は機密情報を含みうる）
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[opencode-viewer] http://127.0.0.1:${PORT} で起動しました`);
  console.log(`[opencode-viewer] 終了は Ctrl+C`);
});

function shutdown(signal: string): void {
  console.log(`[opencode-viewer] ${signal} を受信したため終了します`);
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
