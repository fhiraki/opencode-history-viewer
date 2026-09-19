import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  clampInt,
  clampMs,
  isValidId,
  parsePort,
  parseQuery,
  resolveStaticPath,
} from "../src/shared/validate.ts";

describe("parsePort", () => {
  it("uses the fallback for missing or out-of-range values", () => {
    assert.equal(parsePort(undefined), 8083);
    assert.equal(parsePort("0"), 8083);
    assert.equal(parsePort("70000"), 8083);
    assert.equal(parsePort("abc"), 8083);
  });
  it("floors valid ports", () => {
    assert.equal(parsePort("3000"), 3000);
    assert.equal(parsePort("3000.9"), 3000);
  });
});

describe("clampInt", () => {
  it("normalizes query numbers to finite integers in range", () => {
    assert.equal(clampInt("10", 50, 200), 10);
    assert.equal(clampInt("10.9", 50, 200), 10);
    assert.equal(clampInt(null, 50, 200), 50);
    assert.equal(clampInt("abc", 50, 200), 50);
    assert.equal(clampInt("-5", 50, 200), 0);
    assert.equal(clampInt("9999", 50, 200), 200);
    assert.equal(clampInt("Infinity", 50, 200), 50);
  });
});

describe("clampMs", () => {
  it("rejects NaN and negative epochs as unspecified", () => {
    assert.equal(clampMs("abc"), 0);
    assert.equal(clampMs("-1"), 0);
    assert.equal(clampMs(null), 0);
  });
  it("floors valid epochs", () => {
    assert.equal(clampMs("123.9"), 123);
  });
});

describe("isValidId", () => {
  it("accepts alphanumerics, dash and underscore", () => {
    assert.equal(isValidId("ses_abc-123"), true);
  });
  it("rejects empty, oversized and hostile input", () => {
    assert.equal(isValidId(""), false);
    assert.equal(isValidId("a".repeat(129)), false);
    assert.equal(isValidId("../evil"), false);
    assert.equal(isValidId("a/b"), false);
    assert.equal(isValidId("a b"), false);
    assert.equal(isValidId("a.b"), false);
  });
});

describe("resolveStaticPath", () => {
  // 個人のパスを避けるため tmp配下の架空ディレクトリを使う（FSには触らない純粋解決）
  const pub = path.join(os.tmpdir(), "opencode-viewer-test-public");
  it("maps / to index.html and keeps inner files inside", () => {
    assert.equal(
      resolveStaticPath("/", pub),
      path.resolve(pub, "./index.html"),
    );
    assert.equal(
      resolveStaticPath("/dist/app.js", pub),
      path.resolve(pub, "./dist/app.js"),
    );
  });
  it("blocks traversal outside the public dir", () => {
    assert.equal(resolveStaticPath("/../secret", pub), "forbidden");
    assert.equal(resolveStaticPath("/%2e%2e/secret", pub), "forbidden");
  });
  it("blocks sibling directories with a shared prefix", () => {
    // 素朴な startsWith(PUBLIC_DIR) では突破されるケース（sep 付き照合が必要）
    assert.equal(
      resolveStaticPath("/../opencode-viewer-test-public2/x", pub),
      "forbidden",
    );
  });
  it("rejects malformed encodings and null bytes", () => {
    assert.equal(resolveStaticPath("/%", pub), null);
    assert.equal(resolveStaticPath("/%00", pub), null);
  });
});

describe("parseQuery", () => {
  it("splits pathname and params", () => {
    const { pathname, params } = parseQuery("/api/sessions?limit=10&q=a");
    assert.equal(pathname, "/api/sessions");
    assert.equal(params.get("limit"), "10");
    assert.equal(params.get("q"), "a");
  });
  it("defaults missing urls to /", () => {
    assert.equal(parseQuery(undefined).pathname, "/");
  });
});
