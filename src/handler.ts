import fs from "node:fs";
import fsp from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  getSessionDetail,
  getStats,
  getTimeline,
  listProjects,
  listSessions,
  searchParts,
} from "./db.ts";
import {
  clampInt,
  clampMs,
  isValidId,
  parseQuery,
  resolveStaticPath,
} from "./shared/validate.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// DB 由来の内容を描画するため、外部リソース読み込みを禁じた CSP を全レスポンスへ付ける。
// style はタイムラインのバー等が inline style 属性を使うため 'unsafe-inline' を許可する
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
};

export interface HandlerOptions {
  /** 静的ファイルのルート（public/） */
  publicDir: string;
  /** ~/ 短縮表示に使うホームディレクトリ */
  home: string;
}

/** リクエストハンドラを生成する（server.ts から接続、テストからは HTTP サーバーに載せて検証する） */
export function createHandler(
  db: DatabaseSync,
  { publicDir, home }: HandlerOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  function sendJson(
    res: http.ServerResponse,
    obj: unknown,
    status = 200,
  ): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
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
          res.writeHead(404, {
            "Content-Type": "text/plain; charset=utf-8",
            ...SECURITY_HEADERS,
          });
          res.end("Not Found");
          return;
        }
        sendFile(res, path.join(publicDir, "index.html"), true);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
        ...SECURITY_HEADERS,
      });
      res.end(data);
    });
  }

  return async function handle(req, res) {
    let pathname = "/";
    let params = new URLSearchParams();
    try {
      ({ pathname, params } = parseQuery(req.url));

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, { ok: true });
      }
      if (req.method === "GET" && pathname === "/api/projects") {
        return sendJson(res, { projects: listProjects(db) });
      }
      if (req.method === "GET" && pathname === "/api/sessions") {
        const result = listSessions(db, {
          limit: clampInt(params.get("limit"), 50, 200, 1),
          offset: clampInt(params.get("offset"), 0, 1_000_000),
          q: (params.get("q") || "").slice(0, 500),
          project: (params.get("project") || "").slice(0, 128),
          from: clampMs(params.get("from")),
          to: clampMs(params.get("to")),
          sort: params.get("sort") || "updated",
        });
        return sendJson(res, { ...result, home });
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
          limit: clampInt(params.get("limit"), 50, 200, 1),
          offset: clampInt(params.get("offset"), 0, 1_000_000),
          project: (params.get("project") || "").slice(0, 128),
        });
        return sendJson(res, { ...result, home });
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
      // 未知の API パスは SPA フォールバックで HTML を返さず JSON 404 にする
      if (pathname.startsWith("/api/")) {
        return sendJson(res, { error: "not found" }, 404);
      }

      // 静的ファイル
      if (req.method === "GET") {
        const resolved = resolveStaticPath(pathname, publicDir);
        if (resolved === null) {
          res.writeHead(400, SECURITY_HEADERS);
          res.end("Bad Request");
          return;
        }
        if (resolved === "forbidden") {
          res.writeHead(403, SECURITY_HEADERS);
          res.end("Forbidden");
          return;
        }
        let stat: fs.Stats | null = null;
        try {
          stat = await fsp.stat(resolved);
        } catch {
          stat = null;
        }
        if (stat?.isFile()) {
          return sendFile(res, resolved);
        }
        // SPA フォールバック
        return sendFile(res, path.join(publicDir, "index.html"));
      }

      res.writeHead(404, SECURITY_HEADERS);
      res.end("Not Found");
    } catch (e) {
      console.error(`[api] ${pathname} error:`, e);
      // 内部詳細（SQLite エラー等）をクライアントに漏らさない
      if (!res.headersSent) sendJson(res, { error: "internal error" }, 500);
      else res.end();
    }
  };
}
