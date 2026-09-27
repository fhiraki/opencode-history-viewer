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

// DNS rebinding 対策として受け付ける Host のリテラル（ポート番号は除いた値）
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Host ヘッダのドメイン部分がループバックのリテラルかどうかを判定する。
 * DNS rebinding では attacker.com を 127.0.0.1 に解決させても IP は同じなので、
 * 解決後の IP ではなく Host のドメイン部分で判定する（CSP は fetch 応答に効かない）。
 * ポート番号（127.0.0.1:8083 / [::1]:8083）は無視し、それ以外の値は拒否する。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const raw = (host ?? "").trim().toLowerCase();
  if (raw === "") return false;
  let name = raw;
  if (raw.startsWith("[")) {
    // [::1]:8083 → "::1"（"[]" の後は ":digits" か空のみ許可）
    const end = raw.indexOf("]");
    if (end < 0) return false;
    const rest = raw.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return false;
    name = raw.slice(1, end);
  } else if (/^[^:]+:\d+$/.test(raw)) {
    // 127.0.0.1:8083 → "127.0.0.1"
    name = raw.slice(0, raw.lastIndexOf(":"));
  }
  // "::1" のようなノーブラケット IPv6 はそのまま照合する
  return LOOPBACK_HOSTS.has(name);
}

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
  /** HEAD はボディだけ捨て、ステータス・ヘッダ（Content-Length 含む）は GET と同じにする */
  function endBody(res: http.ServerResponse, body: string | Buffer): void {
    if (res.req.method === "HEAD") res.end();
    else res.end(body);
  }

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
    endBody(res, body);
  }

  /** プレーン応答（400/403/404/405/500）は必ず Content-Type を付ける（sendFile 経由との整合） */
  function sendText(
    res: http.ServerResponse,
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(message),
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    endBody(res, message);
  }

  function sendFile(res: http.ServerResponse, filePath: string): void {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // stat で存在が確認できたパスの read 失敗（EACCES/EIO 等）はサーバ側障害。
        // 従来はここで index.html の 200 に化け、障害が隠蔽されていた。
        // 在り処が消えていた場合（stat と read の間の競合）だけ 404 にする。
        if (err.code === "ENOENT" || err.code === "ENOTDIR") {
          sendText(res, 404, "Not Found");
          return;
        }
        console.error(`[static] read failed: ${filePath}`, err);
        sendText(res, 500, "Internal Server Error");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
        ...SECURITY_HEADERS,
      });
      endBody(res, data);
    });
  }

  /**
   * fsp.stat は symlink を解決しないため、resolveStaticPath の prefix チェックだけでは
   * public/ 配下に置いた symlink 経由で外部ファイルを配信できてしまう。
   * 実体（realpath）が publicDir 配下であることを再検証する。
   * null は解決できない（消えた・I/O エラー）＝不在扱い。
   */
  async function isInsidePublic(filePath: string): Promise<boolean | null> {
    try {
      const [real, realPublic] = await Promise.all([
        fsp.realpath(filePath),
        fsp.realpath(publicDir),
      ]);
      return real === realPublic || real.startsWith(`${realPublic}${path.sep}`);
    } catch {
      return null;
    }
  }

  return async function handle(req, res) {
    // DNS rebinding 対策: Host がループバックでない要求は全ルート（API・静的・
    // SPA フォールバック）で 403。ルーティングの先頭に置かないと1系統が漏れる
    if (!isLoopbackHost(req.headers.host)) {
      return sendText(res, 403, "Forbidden");
    }

    // GET / HEAD のみ許可。それ以外は API 分岐・静的分岐を問わず 405
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendText(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    }

    const target = req.url ?? "/";
    // "//" 始まりは new URL がプロトコル相対 URL と解釈し "http://api/nope" のように
    // 別オリジンとして扱って pathname を "/nope" に取り違えるため、先に 400 で弾く
    if (target.startsWith("//")) {
      return sendText(res, 400, "Bad Request");
    }

    let pathname = "/";
    let params = new URLSearchParams();
    try {
      ({ pathname, params } = parseQuery(target));

      if (pathname === "/api/health") {
        return sendJson(res, { ok: true });
      }
      if (pathname === "/api/projects") {
        return sendJson(res, { projects: listProjects(db) });
      }
      if (pathname === "/api/sessions") {
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
      if (pathname.startsWith("/api/session/")) {
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
      if (pathname === "/api/search") {
        const result = searchParts(db, {
          q: (params.get("q") || "").slice(0, 500),
          limit: clampInt(params.get("limit"), 50, 200, 1),
          offset: clampInt(params.get("offset"), 0, 1_000_000),
          project: (params.get("project") || "").slice(0, 128),
        });
        return sendJson(res, { ...result, home });
      }
      if (pathname === "/api/timeline") {
        return sendJson(res, {
          days: getTimeline(db, {
            project: (params.get("project") || "").slice(0, 128),
          }),
        });
      }
      if (pathname === "/api/stats") {
        return sendJson(res, getStats(db));
      }
      // 未知の API パスは SPA フォールバックで HTML を返さず JSON 404 にする
      if (pathname.startsWith("/api/")) {
        return sendJson(res, { error: "not found" }, 404);
      }

      // 静的ファイル
      const resolved = resolveStaticPath(pathname, publicDir);
      if (resolved === null) {
        return sendText(res, 400, "Bad Request");
      }
      if (resolved === "forbidden") {
        return sendText(res, 403, "Forbidden");
      }
      let stat: fs.Stats | null = null;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        stat = null;
      }
      if (stat?.isFile()) {
        const inside = await isInsidePublic(resolved);
        if (inside === false) return sendText(res, 403, "Forbidden");
        if (inside === true) return sendFile(res, resolved);
        // realpath に失敗 → 在り処が消えた扱いにして下の規則へ
      }
      // 拡張子付きのパスがファイルとして存在しない場合は SPA フォールバックしない
      // （/dist/app.js のビルド漏れ等を index.html の 200 で無言に隠さないため）
      if (path.extname(resolved) !== "") {
        return sendText(res, 404, "Not Found");
      }
      // SPA フォールバックは「stat で不在と確認した拡張子なしパス」だけにする。
      // fallback 先の index.html 自体も realpath 検証に通す（/index.html を直接要求した
      // 場合と同様に、public/index.html が外部を指す symlink でも無検証配信にしない）
      const indexPath = path.join(publicDir, "index.html");
      const indexInside = await isInsidePublic(indexPath);
      if (indexInside === false) return sendText(res, 403, "Forbidden");
      // realpath に失敗＝実在を確認できないため安全側で 404（sendFile と同じ倒し方）
      if (indexInside !== true) return sendText(res, 404, "Not Found");
      return sendFile(res, indexPath);
    } catch (e) {
      console.error(`[api] ${pathname} error:`, e);
      // 内部詳細（SQLite エラー等）をクライアントに漏らさない
      if (!res.headersSent) sendJson(res, { error: "internal error" }, 500);
      else res.end();
    }
  };
}
