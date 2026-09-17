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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = Number(process.env.PORT || 8083);
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
  });
  res.end(body);
}

function sendFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

function parseQuery(url: string | undefined): {
  pathname: string;
  params: URLSearchParams;
} {
  const u = new URL(url ?? "/", "http://localhost");
  return { pathname: u.pathname, params: u.searchParams };
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
        limit: Math.min(Number(params.get("limit") || 50), 200),
        offset: Number(params.get("offset") || 0),
        q: params.get("q") || "",
        project: params.get("project") || "",
        from: Number(params.get("from") || 0),
        to: Number(params.get("to") || 0),
        sort: params.get("sort") || "updated",
      });
      return sendJson(res, { ...result, home: os.homedir() });
    }
    if (req.method === "GET" && pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(pathname.slice("/api/session/".length));
      if (!id) return sendJson(res, { error: "missing id" }, 400);
      const detail = getSessionDetail(db, id);
      if (!detail) return sendJson(res, { error: "not found" }, 404);
      return sendJson(res, detail);
    }
    if (req.method === "GET" && pathname === "/api/search") {
      const result = searchParts(db, {
        q: params.get("q") || "",
        limit: Math.min(Number(params.get("limit") || 50), 200),
        offset: Number(params.get("offset") || 0),
        project: params.get("project") || "",
      });
      return sendJson(res, { ...result, home: os.homedir() });
    }
    if (req.method === "GET" && pathname === "/api/timeline") {
      return sendJson(res, {
        days: getTimeline(db, { project: params.get("project") || "" }),
      });
    }
    if (req.method === "GET" && pathname === "/api/stats") {
      return sendJson(res, getStats(db));
    }

    // 静的ファイル
    if (req.method === "GET") {
      const rel = pathname === "/" ? "/index.html" : pathname;
      // パストラバーサル防止
      const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(PUBLIC_DIR, safe);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return sendFile(res, filePath);
      }
      // SPA フォールバック
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (e) {
    console.error(`[api] ${pathname} error:`, e);
    sendJson(res, { error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[opencode-viewer] http://localhost:${PORT} で起動しました`);
  console.log(`[opencode-viewer] 終了は Ctrl+C`);
});
