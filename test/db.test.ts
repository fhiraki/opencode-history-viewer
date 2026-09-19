import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { listSessions, searchParts } from "../src/db.ts";

// 実 DB には触らない。:memory: に最小スキーマを作り、プレビュー選択と
// スニペット生成の振る舞いだけを検証する。
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT,
      title TEXT, time_created INTEGER, time_updated INTEGER, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, agent TEXT, model TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const sess = db.prepare(
    `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  sess.run("s1", "p1", "/tmp/x", "first", 1000, 3000);
  sess.run("s2", "p1", "/tmp/x", "second", 1000, 2000);
  sess.run("s3", "p1", "/tmp/x", "third", 1000, 1000);
  const msg = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  );
  msg.run("m1", "s1", 1, 1, '{"role":"user"}');
  msg.run("m2", "s1", 2, 2, '{"role":"assistant"}');
  msg.run("m3", "s2", 1, 1, '{"role":"assistant"}');
  msg.run("m4", "s3", 1, 1, '{"role":"user"}');
  const part = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // 空 text はスキップされること（先頭に置く）
  part.run("p0", "m1", "s1", 1, 1, '{"type":"text","text":""}');
  part.run(
    "p1",
    "m1",
    "s1",
    2,
    2,
    '{"type":"text","text":"user question alpha"}',
  );
  part.run("p2", "m2", "s1", 3, 3, '{"type":"text","text":"assistant answer"}');
  part.run("p3", "m3", "s2", 1, 1, '{"type":"text","text":"only answer"}');
  part.run(
    "p4",
    "m4",
    "s3",
    1,
    1,
    '{"type":"tool","tool":"read","state":{"input":{"filePath":"/a.ts"},"output":"x"}}',
  );
  return db;
}

describe("listSessions preview", () => {
  it("prefers the first user text, skipping empty parts", () => {
    const db = fixture();
    try {
      const { sessions } = listSessions(db, {});
      const byId = new Map(sessions.map((s) => [String(s.id), s]));
      assert.equal(byId.get("s1")?.preview, "user question alpha");
      assert.equal(byId.get("s2")?.preview, "only answer");
      assert.equal(byId.get("s3")?.preview, "");
    } finally {
      db.close();
    }
  });
});

describe("searchParts snippet", () => {
  it("finds term matches with a positioned snippet", () => {
    const db = fixture();
    try {
      const { total, hits } = searchParts(db, { q: "alpha" });
      assert.ok(total >= 1);
      assert.ok(
        hits.some(
          (h) =>
            typeof h.snippet === "string" &&
            (h.snippet as string).includes("alpha") &&
            typeof h.matchPos === "number" &&
            (h.matchPos as number) >= 0,
        ),
      );
    } finally {
      db.close();
    }
  });
  it("returns empty for blank queries", () => {
    const db = fixture();
    try {
      assert.deepEqual(searchParts(db, { q: "   " }), { total: 0, hits: [] });
    } finally {
      db.close();
    }
  });
});
