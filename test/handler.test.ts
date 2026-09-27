import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createHandler, isLoopbackHost } from "../src/handler.ts";
import { dayStr, fixture } from "./fixture.ts";

/** /api/projects のレスポンス形 */
interface ProjectsBody {
  projects: { id: string; sessionCount: number }[];
}

/** /api/search・/api/sessions のレスポンス形（home は ~/ 短縮表示に使う） */
interface SearchBody {
  total: number;
  hits: { part_id: string; session_id: string }[];
  home: string;
}

interface SessionsBody {
  total: number;
  sessions: { id: string; messageCount: number }[];
  home: string;
}

/** /api/timeline のレスポンス形 */
interface TimelineBody {
  days: {
    date: string;
    sessions: number;
    messages: number;
    cost: number;
    titles: string[];
  }[];
}

/** /api/stats のレスポンス形 */
interface StatsBody {
  sessionCount: number;
  messageCount: number;
  partCount: number;
  tokens: { ti: number; tout: number; tr: number; cost: number };
  perProject: { id: string }[];
  toolUsage: { tool: string }[];
  range?: { minT: number; maxT: number };
}

// 実 HTTP サーバーを一時ポートで立て、handler のルーティング・ヘッダ・
// 異常入力への耐性を検証する（public/ は一時ディレクトリで代替）。
// opts.breakDb は db.prepare を例外に差し替え、500 経路を検証するためのもの。
async function withServer(
  fn: (base: string, port: number, publicDir: string) => Promise<void>,
  opts: { breakDb?: boolean } = {},
): Promise<void> {
  const publicDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ocv-public-"));
  const db: DatabaseSync = fixture();
  const originalError = console.error;
  let server: http.Server | null = null;
  try {
    await fsp.writeFile(
      path.join(publicDir, "index.html"),
      "<!doctype html><title>test</title>",
    );
    if (opts.breakDb) {
      db.prepare = (): never => {
        throw new Error("synthetic prepare failure");
      };
      // ハンドラの console.error（スタックトレース付き）をテスト出力に混ぜない
      console.error = (): void => {
        // 握りつぶす（500 の検証は戻り値で行う）
      };
    }
    const srv = http.createServer(
      createHandler(db, { publicDir, home: os.homedir() }),
    );
    server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", resolve);
    });
    const { port } = srv.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`, port, publicDir);
  } finally {
    // mkdtemp 直後から try に入れ、listen が throw しても console.error の
    // 差し替えと tmpdir が残らないようにする
    console.error = originalError;
    if (server) {
      const srv = server;
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    db.close();
    await fsp.rm(publicDir, { recursive: true, force: true });
  }
}

// Host は既定でループバック（fetch が送るのと同じ値）。第3引数で差し替えて
// ループバック以外の Host を送るテストに使う。
function rawRequest(
  port: number,
  requestLine: string,
  host = `127.0.0.1:${port}`,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `${requestLine}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
    });
    // 応答を返さない回帰でも node:test が無限待ちにならないよう打ち切る
    socket.setTimeout(5000, () => {
      socket.destroy(new Error("no response within 5s"));
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("isLoopbackHost", () => {
  it("accepts loopback literals, with or without a port", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("127.0.0.1:8083"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("LocalHost:8083"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("[::1]:8083"), true);
    assert.equal(isLoopbackHost("::1"), true);
  });

  it("rejects everything else", () => {
    assert.equal(isLoopbackHost("attacker.com"), false);
    assert.equal(isLoopbackHost("attacker.com:8083"), false);
    assert.equal(isLoopbackHost("127.0.0.1.attacker.com"), false);
    assert.equal(isLoopbackHost("evil.example:80"), false);
    assert.equal(isLoopbackHost("127.0.0.1.evil"), false);
    assert.equal(isLoopbackHost(""), false);
    assert.equal(isLoopbackHost(undefined), false);
  });
});

describe("createHandler", () => {
  it("serves health with security headers and no DB path", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.match(
        res.headers.get("content-security-policy") ?? "",
        /default-src 'self'/,
      );
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    });
  });

  it("returns JSON 404 for unknown API paths", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/nope`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not found" });
    });
  });

  it("rejects malformed session ids", async () => {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/api/session/..%2Fetc`);
      assert.equal(bad.status, 400);
      const missing = await fetch(`${base}/api/session/s_unknown`);
      assert.equal(missing.status, 404);
      const ok = await fetch(`${base}/api/session/s1`);
      assert.equal(ok.status, 200);
    });
  });

  it("clamps limit to at least 1 and serves home", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/sessions?limit=0`);
      const body = (await res.json()) as SessionsBody;
      assert.equal(body.sessions.length, 1);
      // home は ~ 短縮表示に使う値。テスト内に個人パスを書かない
      assert.equal(body.home, os.homedir());
      assert.equal(body.total, 3);
      assert.equal(body.sessions[0]?.messageCount, 1);
    });
  });

  it("serves /api/projects with per-project counts", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/projects`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = (await res.json()) as ProjectsBody;
      assert.deepEqual(
        body.projects.map((p) => p.id),
        ["p2", "p1", "p3"],
      );
      assert.equal(body.projects[0]?.sessionCount, 1);
      assert.equal(body.projects[1]?.sessionCount, 2);
      // セッションを持たない project も返る（LEFT JOIN の0件側）
      assert.equal(body.projects[2]?.sessionCount, 0);
    });
  });

  it("serves /api/search with hits, total and home", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/search?q=alpha`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = (await res.json()) as SearchBody;
      assert.equal(body.total, 1);
      assert.equal(body.hits[0]?.part_id, "p1");
      assert.equal(body.hits[0]?.session_id, "s1");
      assert.equal(body.home, os.homedir());
      // 空クエリは 0 件（500 にしない）
      const blank = await fetch(`${base}/api/search?q=`);
      const blankBody = (await blank.json()) as SearchBody;
      assert.equal(blankBody.total, 0);
      assert.deepEqual(blankBody.hits, []);
    });
  });

  it("serves /api/timeline with day buckets and project filter", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/timeline`);
      assert.equal(res.status, 200);
      const d17 = new Date(2026, 8, 17);
      const d19 = new Date(2026, 8, 19);
      const d20 = new Date(2026, 8, 20);
      const body = (await res.json()) as TimelineBody;
      const expectedDates = [dayStr(d20), dayStr(d19), dayStr(d17)];
      assert.deepEqual(
        body.days.map((d) => d.date),
        expectedDates,
      );
      assert.equal(body.days[0]?.sessions, 1);
      assert.equal(body.days[0]?.messages, 1);
      assert.equal(body.days[0]?.cost, 0.25);
      assert.deepEqual(body.days[0]?.titles, ["third"]);
      // project フィルタも 1 本のルートを通る
      const filtered = await fetch(`${base}/api/timeline?project=p1`);
      const filteredBody = (await filtered.json()) as TimelineBody;
      const p1Dates = [dayStr(d19), dayStr(d17)];
      assert.deepEqual(
        filteredBody.days.map((d) => d.date),
        p1Dates,
      );
    });
  });

  it("serves /api/stats with counts, tokens and range", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/stats`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = (await res.json()) as StatsBody;
      assert.equal(body.sessionCount, 3);
      assert.equal(body.messageCount, 4);
      assert.equal(body.partCount, 19);
      const tokens = { ti: 1800, tout: 360, tr: 90, cost: 2 };
      assert.deepEqual(body.tokens, tokens);
      assert.equal(body.perProject.length, 2);
      assert.equal(body.perProject[0]?.id, "p1");
      assert.equal(typeof body.range?.minT, "number");
      assert.equal(typeof body.range?.maxT, "number");
    });
  });

  it("returns 500 internal error without leaking details", async () => {
    await withServer(
      async (base) => {
        // ヘルスチェックは DB を使わないため生きているまま
        const health = await fetch(`${base}/api/health`);
        assert.equal(health.status, 200);
        const res = await fetch(`${base}/api/stats`);
        assert.equal(res.status, 500);
        assert.match(
          res.headers.get("content-type") ?? "",
          /application\/json/,
        );
        assert.match(
          res.headers.get("content-security-policy") ?? "",
          /default-src 'self'/,
        );
        const body = await res.text();
        assert.deepEqual(JSON.parse(body), { error: "internal error" });
        assert.equal(body.includes("synthetic prepare failure"), false);
      },
      { breakDb: true },
    );
  });

  it("returns 400 for a malformed percent-encoding in the path", async () => {
    await withServer(async (_base, port) => {
      // decodeURIComponent が失敗するパスは resolveStaticPath が null を返す
      const raw = await rawRequest(port, "GET /% HTTP/1.1");
      assert.match(raw, /^HTTP\/1\.1 400/);
      assert.match(raw, /content-type: text\/plain; charset=utf-8/i);
      assert.match(raw, /content-security-policy/i);
      // 通常ルートは影響を受けない
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
    });
  });

  it("survives a malformed absolute-form request target", async () => {
    await withServer(async (_base, port) => {
      const raw = await rawRequest(port, "GET http://[ HTTP/1.1");
      assert.match(raw, /^HTTP\/1\.1 200/);
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
    });
  });

  it("serves static files, SPA fallback and blocks traversal", async () => {
    await withServer(async (base, port) => {
      const index = await fetch(`${base}/`);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /<title>test/);
      const fallback = await fetch(`${base}/some/spa/route`);
      assert.equal(fallback.status, 200);
      // fetch は %2e%2e を正規化するため、生ソケットでエンコード済み traversal を送る
      const forbidden = await rawRequest(port, "GET /%2e%2e%2fsecret HTTP/1.1");
      assert.match(forbidden, /^HTTP\/1\.1 403/);
      // プレーン応答にも Content-Type が付く（sendFile 経由との整合）
      assert.match(forbidden, /content-type: text\/plain; charset=utf-8/i);
      assert.match(forbidden, /content-security-policy/i);
    });
  });

  it("rejects non-loopback Host headers with 403 on every route", async () => {
    await withServer(async (_base, port) => {
      // DNS rebinding: 外部ページが attacker.com を 127.0.0.1 に解決させても、
      // Host のドメイン部分がループバックでなければ履歴 JSON を読めない
      const api = await rawRequest(
        port,
        "GET /api/health HTTP/1.1",
        "attacker.com:8083",
      );
      assert.match(api, /^HTTP\/1\.1 403/);
      assert.match(api, /content-type: text\/plain; charset=utf-8/i);
      assert.match(api, /content-security-policy/i);
      // 静的・SPA フォールバックも同じ判定
      const spa = await rawRequest(port, "GET / HTTP/1.1", "evil.example");
      assert.match(spa, /^HTTP\/1\.1 403/);
      // ループバックのリテラル（ポート付き・IPv6）は通る
      const ok = await rawRequest(port, "GET /api/health HTTP/1.1");
      assert.match(ok, /^HTTP\/1\.1 200/);
      const v6 = await rawRequest(
        port,
        "GET /api/health HTTP/1.1",
        "[::1]:8083",
      );
      assert.match(v6, /^HTTP\/1\.1 200/);
    });
  });

  it("serves HEAD without a body and rejects other methods with 405", async () => {
    await withServer(async (base) => {
      // HEAD は GET と同じ経路・ステータス・ヘッダでボディだけ捨てる
      const head = await fetch(`${base}/api/health`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.match(
        head.headers.get("content-security-policy") ?? "",
        /default-src 'self'/,
      );
      assert.equal(
        head.headers.get("content-length"),
        String(Buffer.byteLength(JSON.stringify({ ok: true }))),
      );
      const headStatic = await fetch(`${base}/`, { method: "HEAD" });
      assert.equal(headStatic.status, 200);
      assert.equal(await headStatic.text(), "");
      assert.match(headStatic.headers.get("content-type") ?? "", /text\/html/);

      // GET/HEAD 以外は 405 + Allow（API 分岐）
      const post = await fetch(`${base}/api/health`, { method: "POST" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET, HEAD");
      assert.match(post.headers.get("content-type") ?? "", /text\/plain/);
      // 静的分岐でも同じ
      const put = await fetch(`${base}/`, { method: "PUT" });
      assert.equal(put.status, 405);
      assert.equal(put.headers.get("allow"), "GET, HEAD");
    });
  });

  it("returns 500 instead of index.html when a stat-confirmed file cannot be read", async (t) => {
    await withServer(async (base, _port, publicDir) => {
      // root は chmod 000 でも読める。getuid が無い環境（Windows 等）は
      // 権限が効かず読めてしまうため、どちらもこの検証は成立しない
      if (typeof process.getuid !== "function" || process.getuid() === 0) {
        t.skip("needs a non-root uid for chmod to make a file unreadable");
        return;
      }
      const blocked = path.join(publicDir, "blocked.txt");
      await fsp.writeFile(blocked, "unreadable");
      await fsp.chmod(blocked, 0o000);
      try {
        const res = await fetch(`${base}/blocked.txt`);
        // 障害が index.html の 200 に化けないことを確認
        assert.equal(res.status, 500);
        assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
        assert.match(
          res.headers.get("content-security-policy") ?? "",
          /default-src 'self'/,
        );
        const body = await res.text();
        assert.ok(!body.includes("<title>test"));
      } finally {
        await fsp.chmod(blocked, 0o644);
      }
    });
  });

  it("returns 404 for missing paths with an extension, SPA fallback without", async () => {
    await withServer(async (base) => {
      // 拡張子付きの欠落パスはビルド漏れの兆候なのでフォールバックしない
      const missing = await fetch(`${base}/dist/app.js`);
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get("content-type") ?? "", /text\/plain/);
      assert.ok(!(await missing.text()).includes("<title>test"));
      const css = await fetch(`${base}/style.css`);
      assert.equal(css.status, 404);
      // 拡張子なし（ルート・ディレクトリ風）は従来どおり index.html
      const spa = await fetch(`${base}/some/spa/route`);
      assert.equal(spa.status, 200);
      assert.match(await spa.text(), /<title>test/);
    });
  });

  it("rejects protocol-relative (//) request targets with 400", async () => {
    await withServer(async (_base, port) => {
      // "//api/nope" は new URL で "http://api/nope" と解釈され pathname が
      // "/nope" に取り違えるため、parseQuery 済みに渡さず 400 で弾く
      const raw = await rawRequest(port, "GET //api/nope HTTP/1.1");
      assert.match(raw, /^HTTP\/1\.1 400/);
      assert.match(raw, /content-type: text\/plain; charset=utf-8/i);
      assert.match(raw, /content-security-policy/i);
      // 通常のターゲットは影響を受けない
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
    });
  });

  it("blocks static files that escape publicDir through a symlink", async (t) => {
    await withServer(async (base, _port, publicDir) => {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "ocv-outside-"));
      try {
        await fsp.writeFile(path.join(outside, "secret.txt"), "outside secret");
        const link = path.join(publicDir, "leak.txt");
        try {
          await fsp.symlink(path.join(outside, "secret.txt"), link);
        } catch {
          t.skip("symlinks cannot be created in this environment");
          return;
        }
        const res = await fetch(`${base}/leak.txt`);
        assert.equal(res.status, 403);
        assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
        const body = await res.text();
        assert.ok(!body.includes("outside secret"));
        assert.ok(!body.includes("<title>test"));
      } finally {
        await fsp.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("verifies index.html through realpath on the SPA fallback", async (t) => {
    await withServer(async (base, _port, publicDir) => {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "ocv-outside-"));
      const indexPath = path.join(publicDir, "index.html");
      const backupPath = path.join(publicDir, "index.html.bak");
      try {
        await fsp.writeFile(
          path.join(outside, "secret.html"),
          "<title>outside secret</title>",
        );
        // index.html を退避して外部ファイルを指す symlink に差し替える
        await fsp.rename(indexPath, backupPath);
        try {
          await fsp.symlink(path.join(outside, "secret.html"), indexPath);
        } catch {
          // 退避した index.html は finally で元に戻す
          t.skip("symlinks cannot be created in this environment");
          return;
        }
        // "/" は resolveStaticPath で index.html に解決される（stat 経由で既に 403）。
        // 拡張子なしの未存在パスだけが通るフォールバック経路も同じ検証に通ること
        const spa = await fetch(`${base}/some/spa/route`);
        assert.equal(spa.status, 403);
        const spaBody = await spa.text();
        assert.ok(!spaBody.includes("outside secret"));
        assert.ok(!spaBody.includes("<title>test"));
        const root = await fetch(`${base}/`);
        assert.equal(root.status, 403);
        const rootBody = await root.text();
        assert.ok(!rootBody.includes("outside secret"));
        assert.ok(!rootBody.includes("<title>test"));
      } finally {
        // 元の index.html に戻してから外部ディレクトリを削除する
        await fsp.rm(indexPath, { force: true });
        await fsp.rename(backupPath, indexPath);
        await fsp.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
