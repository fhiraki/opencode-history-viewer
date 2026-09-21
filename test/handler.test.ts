import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createHandler } from "../src/handler.ts";
import { fixture } from "./fixture.ts";

// 実 HTTP サーバーを一時ポートで立て、handler のルーティング・ヘッダ・
// 異常入力への耐性を検証する（public/ は一時ディレクトリで代替）。
async function withServer(
  fn: (base: string, port: number) => Promise<void>,
): Promise<void> {
  const publicDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ocv-public-"));
  await fsp.writeFile(
    path.join(publicDir, "index.html"),
    "<!doctype html><title>test</title>",
  );
  const db: DatabaseSync = fixture();
  const server = http.createServer(
    createHandler(db, { publicDir, home: os.homedir() }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await fsp.rm(publicDir, { recursive: true, force: true });
  }
}

function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
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

  it("clamps limit to at least 1", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/sessions?limit=0`);
      const body = (await res.json()) as { sessions: unknown[] };
      assert.equal(body.sessions.length, 1);
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
    });
  });
});
