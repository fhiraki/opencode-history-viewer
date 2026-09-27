import { DatabaseSync } from "node:sqlite";

// 実 DB には触らない。:memory: に最小スキーマを作り、各クエリ関数の振る舞い
// （プレビュー・スニペット・caps・集計・日別バケット）を検証する共有フィクスチャ。
// 日付はすべてローカル時刻で組み立てる（CI は UTC で日付表示がずれるため）。
// 個人パスは書かない。fixture は全テストで共有するので値を変えたら
// test/ 配下の期待値をまとめて更新すること。
//
// 構成:
//   project: p1 / p2(worktree NULL) / p3(セッション無し = LEFT JOIN の0件側)
//   session: s1(9/17・p1) s2(9/19・p1) s3(9/20・p2) の3日跨ぎ
//   part: text / reasoning / tool / patch / subtask / compaction /
//         step-start・step-finish / 未知型の全分岐に加え、caps の内側と外側に
//         ヒット語を置いた長大パート（9000字本文・2000超 files・3000字 title）

const pad = (n: number): string => String(n).padStart(2, "0");

/** ローカル暦日を YYYY-MM-DD に変換する（タイムライン日付の期待値用） */
export function dayStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

  // project: p1/p2 はセッションを持ち p3 は持たない（listProjects の LEFT JOIN）。
  // p2.worktree は NULL（listProjects は NULL のまま、perProject は "" に COALESCE）。
  const project = db.prepare(
    `INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)`,
  );
  project.run("p1", "/wt/alpha", "Alpha");
  project.run("p2", null, "Beta");
  project.run("p3", "/wt/gamma", "Gamma");

  // 3日に跨るセッション。cost / tokens / agent / model も投入しておき、
  // getStats の SUM と listSessions の列選択を検証可能にする
  const s1c = new Date(2026, 8, 17, 9, 0).getTime();
  const s1u = new Date(2026, 8, 17, 10, 0).getTime();
  const s2c = new Date(2026, 8, 19, 12, 0).getTime();
  const s2u = new Date(2026, 8, 19, 13, 0).getTime();
  const s3c = new Date(2026, 8, 20, 15, 0).getTime();
  const s3u = new Date(2026, 8, 20, 16, 0).getTime();
  const sess = db.prepare(
    `INSERT INTO session (id, project_id, directory, title, time_created,
      time_updated, cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, agent, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sess.run(
    "s1",
    "p1",
    "/work/alpha_dir",
    "first",
    s1c,
    s1u,
    1.25,
    1000,
    200,
    50,
    100,
    10,
    "build",
    '{"id":"m1","providerID":"prov","variant":"default"}',
  );
  sess.run(
    "s2",
    "p1",
    "/work/alpha_dir",
    "second",
    s2c,
    s2u,
    0.5,
    500,
    100,
    25,
    0,
    0,
    "plan",
    "legacy-model",
  );
  sess.run(
    "s3",
    "p2",
    "/work/beta",
    "third",
    s3c,
    s3u,
    0.25,
    300,
    60,
    15,
    5,
    5,
    null,
    null,
  );

  // message は各セッションの作成直後（すべて同日内）
  const m1 = s1c + 60_000;
  const m2 = s1c + 120_000;
  const m3 = s2c + 60_000;
  const m4 = s3c + 60_000;
  const msg = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  );
  msg.run("m1", "s1", m1, m1, '{"role":"user"}');
  msg.run("m2", "s1", m2, m2, '{"role":"assistant","modelID":"m"}');
  msg.run("m3", "s2", m3, m3, '{"role":"assistant"}');
  msg.run("m4", "s3", m4, m4, '{"role":"user"}');

  const part = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const addPart = (
    id: string,
    messageId: string,
    sessionId: string,
    at: number,
    data: string,
  ): void => {
    part.run(id, messageId, sessionId, at, at, data);
  };

  const userText = '{"type":"text","text":"user question alpha"}';
  const answerText = '{"type":"text","text":"assistant answer"}';
  const progressText = '{"type":"text","text":"progress 100% done"}';
  const quoteText = JSON.stringify({
    type: "text",
    text: 'say "hi" C:\\path',
  });
  const readTool = JSON.stringify({
    type: "tool",
    tool: "read",
    state: { input: { filePath: "/a.ts" }, output: "x" },
  });

  // caps 検証: 本文 8000 / tool 入力 4000 / 出力 8000 / files 2000 / title 1000。
  // 「caps の内側」に MIDTERM、外側（caps 超過位置）にヒット語を置き、
  // 「マッチは全文・スニペットは切り詰め済み断片」の食い違いを検証する
  const p5Head = `${"a".repeat(4440)}MIDTERM${"b".repeat(4053)}`;
  const p5Text = `${p5Head}TOOFAR${"c".repeat(494)}`;
  const p5Data = JSON.stringify({ type: "text", text: p5Text });
  const p6Input = `${"y".repeat(4500)}INPUTTAIL${"y".repeat(491)}`;
  const p6Output = `${"z".repeat(8500)}OUTPUTTAIL${"z".repeat(490)}`;
  const bashTool = JSON.stringify({
    type: "tool",
    tool: "bash",
    state: { input: { command: p6Input }, output: p6Output },
  });
  const p9Text = `${"r".repeat(8000)}REASONTAIL${"r".repeat(990)}`;
  const reasoningData = JSON.stringify({ type: "reasoning", text: p9Text });
  const p10Files = `${"f".repeat(2100)}FILETAIL${"f".repeat(292)}`;
  const patchData = JSON.stringify({
    type: "patch",
    files: ["src/app.ts", p10Files],
    hash: "h1",
  });
  const subtaskData = JSON.stringify({
    type: "subtask",
    agent: "build",
    command: "review",
    description: "review the diff",
    model: "m1",
    prompt: "q".repeat(9000),
  });
  const stepStartData = '{"type":"step-start","reason":"maxsteps"}';
  const mysteryData = JSON.stringify({
    type: "mystery",
    blob: "m".repeat(3000),
  });
  const longTitle = `titlecapstart ${"x".repeat(3000)}`;
  const longTitleTool = JSON.stringify({
    type: "tool",
    tool: "edit",
    state: {
      title: longTitle,
      input: { pattern: "irrelevant" },
      output: "ok",
    },
  });
  const tieA = '{"type":"text","text":"tiebreak same moment aaa"}';
  const tieB = '{"type":"text","text":"tiebreak same moment bbb"}';

  // 空 text はプレビューでスキップされること（先頭に置く）
  addPart("p0", "m1", "s1", m1, '{"type":"text","text":""}');
  addPart("p1", "m1", "s1", m1 + 1000, userText);
  addPart("p2", "m2", "s1", m2, answerText);
  addPart("p5", "m2", "s1", m2 + 1000, p5Data);
  addPart("p6", "m2", "s1", m2 + 2000, bashTool);
  addPart("p12", "m2", "s1", m2 + 3000, '{"type":"compaction","auto":true}');
  addPart("p13", "m2", "s1", m2 + 4000, stepStartData);
  addPart("p14", "m2", "s1", m2 + 5000, '{"type":"step-finish"}');
  // 未知型は else 分岐（rawText = JSON.stringify(raw).slice(0, 2000)）
  addPart("p15", "m2", "s1", m2 + 6000, mysteryData);

  addPart("p3", "m3", "s2", m3, '{"type":"text","text":"only answer"}');
  addPart("p9", "m3", "s2", m3 + 1000, reasoningData);
  // 同時刻の2件: 検索の ORDER BY id DESC 第2キーを検証する
  addPart("tieA", "m3", "s2", m3 + 2000, tieA);
  addPart("tieB", "m3", "s2", m3 + 2000, tieB);

  addPart("p4", "m4", "s3", m4, readTool);
  addPart("p7", "m4", "s3", m4 + 1000, progressText);
  addPart("p8", "m4", "s3", m4 + 2000, quoteText);
  addPart("p10", "m4", "s3", m4 + 3000, patchData);
  addPart("p11", "m4", "s3", m4 + 4000, subtaskData);
  addPart("p16", "m4", "s3", m4 + 5000, longTitleTool);
  return db;
}
