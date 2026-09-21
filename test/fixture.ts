import { DatabaseSync } from "node:sqlite";

// 実 DB には触らない。:memory: に最小スキーマを作り、各クエリ関数の
// 振る舞い（プレビュー・スニペット・caps・集計）を検証するための共有フィクスチャ。
export function fixture(): DatabaseSync {
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
  msg.run("m2", "s1", 2, 2, '{"role":"assistant","modelID":"m"}');
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
  // caps 検証用の長大パート（本文 8000 / tool 入力 4000 / 出力 8000）
  part.run(
    "p5",
    "m2",
    "s1",
    4,
    4,
    JSON.stringify({ type: "text", text: "x".repeat(9000) }),
  );
  part.run(
    "p6",
    "m2",
    "s1",
    5,
    5,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      state: { input: { command: "y".repeat(5000) }, output: "z".repeat(9000) },
    }),
  );
  // LIKE エスケープ検証用（% を含む本文）
  part.run(
    "p7",
    "m4",
    "s3",
    2,
    2,
    '{"type":"text","text":"progress 100% done"}',
  );
  // JSON エスケープ（" と \）を含む本文。prefilter の JSON 表記合わせを検証する
  part.run(
    "p8",
    "m4",
    "s3",
    3,
    3,
    JSON.stringify({ type: "text", text: 'say "hi" C:\\path' }),
  );
  return db;
}
