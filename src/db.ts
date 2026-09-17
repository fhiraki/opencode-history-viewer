import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function defaultDbPath() {
  return (
    process.env.OPENCODE_DB ||
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
  );
}

export function openDb(dbPath = defaultDbPath()): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return db;
}

/** DB 行（全カラムは string | number | null 等）。詳細が必要な箇所で絞り込む */
type Row = Record<string, unknown>;
type JsonObj = Record<string, unknown>;

interface ListSessionsOpts {
  limit?: number;
  offset?: number;
  q?: string;
  project?: string;
  from?: number;
  to?: number;
  sort?: string;
}
interface SearchOpts {
  q?: string;
  limit?: number;
  offset?: number;
  project?: string;
}
interface TimelineOpts {
  project?: string;
}
/** part.data のパース結果。未知フィールドは unknown のまま扱う */
interface PartRaw {
  type?: unknown;
  text?: unknown;
  title?: unknown;
  tool?: unknown;
  state?: {
    input?: unknown;
    output?: unknown;
    title?: unknown;
    status?: unknown;
    metadata?: { output?: unknown };
  } | null;
  files?: unknown;
  hash?: unknown;
  auto?: unknown;
  reason?: unknown;
  time?: unknown;
}

/** LIKE 用エスケープ */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function parseJsonSafe<T>(s: unknown, fallback: T): T {
  try {
    return JSON.parse(typeof s === "string" ? s : "") as T;
  } catch {
    return fallback;
  }
}

/** part.data から人間可読テキストを抽出（検索・表示用） */
export function partDisplayText(partJson: unknown): string {
  if (!partJson || typeof partJson !== "object") return "";
  const p = partJson as JsonObj;
  const t = p.type;
  if (t === "text" || t === "reasoning")
    return typeof p.text === "string" ? p.text : "";
  if (t === "tool") {
    const st = (p.state ?? {}) as JsonObj;
    const meta = (st.metadata ?? {}) as JsonObj;
    const input = st.input ? JSON.stringify(st.input, null, 1) : "";
    const title = p.title || st.title || "";
    const out = st.output || meta.output || "";
    return [title, input, typeof out === "string" ? out : JSON.stringify(out)]
      .filter(Boolean)
      .join("\n");
  }
  if (t === "patch") {
    const files = Array.isArray(p.files) ? p.files : [];
    return `patch ${files.join(", ")}`;
  }
  if (t === "compaction") return "compaction";
  return "";
}

const MAX_TEXT = 8000;

function truncate(
  s: string,
  max: number = MAX_TEXT,
): { text: string; truncated: boolean; fullLength?: number } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true, fullLength: s.length };
}

export function listProjects(db: DatabaseSync): Row[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.worktree, p.name,
        (SELECT COUNT(*) FROM session s WHERE s.project_id = p.id) AS sessionCount,
        (SELECT MAX(s.time_updated) FROM session s WHERE s.project_id = p.id) AS lastActive
       FROM project p ORDER BY lastActive DESC NULLS LAST`,
    )
    .all();
  return rows;
}

export function listSessions(
  db: DatabaseSync,
  opts: ListSessionsOpts = {},
): {
  total: number;
  sessions: Row[];
} {
  const {
    limit = 50,
    offset = 0,
    q = "",
    project = "",
    from = 0,
    to = 0,
    sort = "updated",
  } = opts;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push(
      `(s.title LIKE ? ESCAPE '\\' OR s.directory LIKE ? ESCAPE '\\')`,
    );
    params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }
  if (project) {
    where.push(`s.project_id = ?`);
    params.push(project);
  }
  if (from) {
    where.push(`s.time_updated >= ?`);
    params.push(Number(from));
  }
  if (to) {
    where.push(`s.time_updated <= ?`);
    params.push(Number(to));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order =
    sort === "created" ? `s.time_created DESC` : `s.time_updated DESC`;

  const total =
    (db
      .prepare(`SELECT COUNT(*) AS c FROM session s ${whereSql}`)
      .get(...params)?.c as number) ?? 0;

  const sessions = db
    .prepare(
      `SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
        s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
        s.tokens_cache_read, s.tokens_cache_write, s.agent, s.model,
        (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messageCount
       FROM session s ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, Number(limit), Number(offset));

  // プレビュー: 各セッションの最初の user text（なければ最初の text）
  if (sessions.length) {
    const ids = sessions.map((s) => String(s.id));
    const placeholders = ids.map(() => "?").join(",");
    const previewRows = db
      .prepare(
        `SELECT p.session_id, m.data AS mdata, substr(p.data, 1, 2000) AS pdata, p.time_created
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id IN (${placeholders})
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY p.time_created ASC LIMIT 500`,
      )
      .all(...ids);
    const firstBySession = new Map();
    const fallbackBySession = new Map();
    for (const r of previewRows) {
      const m = parseJsonSafe(r.mdata, {} as JsonObj);
      const p = parseJsonSafe(r.pdata, {} as JsonObj);
      const text = typeof p.text === "string" ? p.text.slice(0, 200) : "";
      if (!text) continue;
      if (!fallbackBySession.has(r.session_id)) {
        fallbackBySession.set(r.session_id, text);
      }
      if (m.role === "user" && !firstBySession.has(r.session_id)) {
        firstBySession.set(r.session_id, text);
      }
    }
    for (const s of sessions) {
      s.preview = firstBySession.get(s.id) || fallbackBySession.get(s.id) || "";
    }
  }
  return { total, sessions };
}

export function getSessionDetail(
  db: DatabaseSync,
  sessionId: string,
): {
  session: Row;
  messages: Record<string, unknown>[];
} | null {
  const session = db
    .prepare(`SELECT * FROM session WHERE id = ?`)
    .get(sessionId);
  if (!session) return null;

  const messages = db
    .prepare(
      `SELECT id, session_id, time_created, time_updated, data FROM message
       WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId);

  const parts = db
    .prepare(
      `SELECT id, message_id, session_id, time_created, time_updated, data FROM part
       WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId);

  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const p of parts) {
    const raw = parseJsonSafe(p.data, { type: "unknown" } as PartRaw);
    const norm = normalizePart(p, raw);
    const key = String(p.message_id);
    if (!partsByMessage.has(key)) partsByMessage.set(key, []);
    partsByMessage.get(key)?.push(norm);
  }

  const normMessages = messages.map((m) => {
    const meta = parseJsonSafe(m.data, {} as JsonObj);
    const metaModel =
      typeof meta.model === "object" && meta.model !== null
        ? (meta.model as JsonObj)
        : undefined;
    return {
      id: m.id,
      role: meta.role || "unknown",
      time_created: m.time_created,
      time_updated: m.time_updated,
      agent: meta.agent || null,
      modelID: meta.modelID || metaModel?.modelID || null,
      tokens: meta.tokens || null,
      cost: meta.cost ?? null,
      finish: meta.finish || null,
      parts: partsByMessage.get(String(m.id)) || [],
    };
  });

  return { session, messages: normMessages };
}

function normalizePart(row: Row, raw: PartRaw): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    type: raw.type || "unknown",
    time_created: row.time_created,
  };
  if (raw.type === "text") {
    const { text, truncated, fullLength } = truncate(
      typeof raw.text === "string" ? raw.text : "",
    );
    base.text = text;
    if (truncated) {
      base.truncated = true;
      base.fullLength = fullLength;
    }
    base.time = raw.time || null;
  } else if (raw.type === "reasoning") {
    const { text, truncated, fullLength } = truncate(
      typeof raw.text === "string" ? raw.text : "",
    );
    base.text = text;
    if (truncated) {
      base.truncated = true;
      base.fullLength = fullLength;
    }
  } else if (raw.type === "tool") {
    const st = (raw.state ?? {}) as NonNullable<PartRaw["state"]>;
    const inputStr = st.input ? JSON.stringify(st.input) : "";
    let outputStr = "";
    if (typeof st.output === "string") outputStr = st.output;
    else if (st.output != null) outputStr = JSON.stringify(st.output);
    if (!outputStr && st.metadata?.output) {
      const metaOut = st.metadata.output;
      outputStr =
        typeof metaOut === "string" ? metaOut : JSON.stringify(metaOut);
    }
    const tIn = truncate(inputStr, 4000);
    const tOut = truncate(outputStr || "", 8000);
    base.tool = raw.tool || "";
    base.title = raw.title || st.title || "";
    base.status = st.status || "";
    base.input = tIn.text;
    base.inputTruncated = tIn.truncated || false;
    base.output = tOut.text;
    base.outputTruncated = tOut.truncated || false;
    base.outputFullLength = tOut.fullLength || outputStr.length;
  } else if (raw.type === "patch") {
    base.files = Array.isArray(raw.files) ? raw.files : [];
    base.hash = raw.hash || "";
  } else if (raw.type === "compaction") {
    base.auto = raw.auto;
  } else if (raw.type === "step-start" || raw.type === "step-finish") {
    base.raw = { reason: raw.reason || null };
  } else {
    base.rawText = JSON.stringify(raw).slice(0, 2000);
  }
  return base;
}

export function searchParts(
  db: DatabaseSync,
  opts: SearchOpts = {},
): {
  total: number;
  hits: Record<string, unknown>[];
} {
  const { q = "", limit = 50, offset = 0, project = "" } = opts;
  const query = q.trim();
  if (!query) return { total: 0, hits: [] };
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);

  const likeConds = terms.map(() => `p.data LIKE ? ESCAPE '\\'`).join(" AND ");
  const params: (string | number)[] = terms.map((t) => `%${escapeLike(t)}%`);
  const projCond = project ? `AND s.project_id = ?` : "";
  if (project) params.push(project);

  // 総件数（軽量化のため上限付きカウントはせず COUNT する。5万件規模なので十分速い）
  const countSql = `SELECT COUNT(*) AS c FROM part p JOIN session s ON s.id = p.session_id
    WHERE ${likeConds} ${projCond}
      AND json_extract(p.data, '$.type') IN ('text','tool','reasoning','patch')`;
  const total = (db.prepare(countSql).get(...params)?.c as number) ?? 0;

  const sql = `SELECT p.session_id, p.message_id, p.id AS part_id, p.time_created,
      substr(p.data, 1, 12000) AS pdata, s.title AS session_title, s.directory, s.project_id
    FROM part p JOIN session s ON s.id = p.session_id
    WHERE ${likeConds} ${projCond}
      AND json_extract(p.data, '$.type') IN ('text','tool','reasoning','patch')
    ORDER BY p.time_created DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, Number(limit), Number(offset));

  const lowerTerms = terms.map((t) => t.toLowerCase());
  const hits = rows.map((r) => {
    const pj = parseJsonSafe(r.pdata, { type: "unknown" } as PartRaw);
    const full = partDisplayText(
      pj.type === "tool" ? { ...pj, state: pj.state } : pj,
    );
    // パース時に切り詰めた pdata(12k) 内でスニペット生成
    const snippet = makeSnippet(full, lowerTerms);
    let toolName: string | null = null;
    let title: string | null = null;
    if (pj.type === "tool") {
      toolName = typeof pj.tool === "string" ? pj.tool : null;
      const pjTitle = pj.title;
      const stTitle =
        typeof pj.state === "object" && pj.state !== null
          ? (pj.state as Record<string, unknown>).title
          : undefined;
      title =
        typeof pjTitle === "string"
          ? pjTitle
          : typeof stTitle === "string"
            ? stTitle
            : null;
    }
    return {
      session_id: r.session_id,
      session_title: r.session_title,
      directory: r.directory,
      project_id: r.project_id,
      message_id: r.message_id,
      part_id: r.part_id,
      part_type: pj.type || "unknown",
      tool: toolName,
      title,
      time_created: r.time_created,
      snippet: snippet.text,
      matchPos: snippet.pos,
    };
  });
  return { total, hits };
}

function makeSnippet(
  full: string,
  lowerTerms: string[],
  radius = 120,
): { text: string; pos: number } {
  if (!full) return { text: "", pos: -1 };
  const lower = full.toLowerCase();
  let best = -1;
  for (const t of lowerTerms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  if (best === -1) return { text: full.slice(0, radius * 2), pos: -1 };
  const start = Math.max(0, best - radius);
  const end = Math.min(
    full.length,
    best + radius + (lowerTerms[0]?.length || 0),
  );
  const prefix = start > 0 ? "…" : "";
  return { text: prefix + full.slice(start, end), pos: best - start };
}

export function getTimeline(
  db: DatabaseSync,
  opts: TimelineOpts = {},
): {
  date: string;
  sessions: number;
  messages: number;
  cost: number;
  titles: string[];
}[] {
  const { project = "" } = opts;
  const projCond = project ? `WHERE project_id = ?` : "";
  const params = project ? [project] : [];
  const sessions = db
    .prepare(
      `SELECT id, time_created, time_updated, project_id, directory, title, COALESCE(cost,0) AS cost FROM session ${projCond} ORDER BY time_created ASC`,
    )
    .all(...params);
  const msgCond = project ? `WHERE s.project_id = ?` : "";
  const msgParams = project ? [project] : [];
  const msgRows = db
    .prepare(
      `SELECT m.time_created FROM message m JOIN session s ON s.id = m.session_id ${msgCond}`,
    )
    .all(...msgParams);

  const byDay = new Map();
  const dayKey = (ms: unknown): string => {
    const d = new Date(Number(ms));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  for (const s of sessions) {
    const k = dayKey(s.time_created);
    if (!byDay.has(k))
      byDay.set(k, { date: k, sessions: 0, messages: 0, cost: 0, titles: [] });
    const e = byDay.get(k);
    e.sessions += 1;
    e.cost += Number(s.cost || 0);
    if (e.titles.length < 5) e.titles.push(s.title);
  }
  for (const m of msgRows) {
    const k = dayKey(m.time_created);
    if (!byDay.has(k))
      byDay.set(k, { date: k, sessions: 0, messages: 0, cost: 0, titles: [] });
    byDay.get(k).messages += 1;
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getStats(db: DatabaseSync): {
  sessionCount: number;
  messageCount: number;
  partCount: number;
  tokens: { ti: number; tout: number; tr: number; cost: number };
  perProject: Row[];
  perModel: Row[];
  toolUsage: Row[];
  range: Row | undefined;
} {
  const sessionCount =
    (db.prepare(`SELECT COUNT(*) AS c FROM session`).get()?.c as number) ?? 0;
  const messageCount =
    (db.prepare(`SELECT COUNT(*) AS c FROM message`).get()?.c as number) ?? 0;
  const partCount =
    (db.prepare(`SELECT COUNT(*) AS c FROM part`).get()?.c as number) ?? 0;
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS tout,
        COALESCE(SUM(tokens_reasoning),0) AS tr, COALESCE(SUM(cost),0) AS cost FROM session`,
    )
    .get();
  const totals = {
    ti: Number(t?.ti ?? 0),
    tout: Number(t?.tout ?? 0),
    tr: Number(t?.tr ?? 0),
    cost: Number(t?.cost ?? 0),
  };
  const perProject = db
    .prepare(
      `SELECT s.project_id AS id, COALESCE(p.worktree,'') AS worktree,
        COUNT(*) AS sessions, COALESCE(SUM(s.cost),0) AS cost,
        MAX(s.time_updated) AS lastActive
       FROM session s LEFT JOIN project p ON p.id = s.project_id
       GROUP BY s.project_id ORDER BY sessions DESC`,
    )
    .all();
  const toolUsage = db
    .prepare(
      `SELECT json_extract(data,'$.tool') AS tool, COUNT(*) AS c FROM part
       WHERE json_extract(data,'$.type')='tool' GROUP BY 1 ORDER BY c DESC LIMIT 20`,
    )
    .all();
  // モデル別集計は message 単位で行う。session.model は最終選択モデルのため、
  // マルチモデルセッション（62件中4件）のコスト按分に使うと誤集計になる
  const perModel = db
    .prepare(
      `SELECT json_extract(m.data,'$.providerID') AS provider,
        json_extract(m.data,'$.modelID') AS id,
        COUNT(*) AS messages,
        COUNT(DISTINCT m.session_id) AS sessions,
        COALESCE(SUM(json_extract(m.data,'$.cost')),0) AS cost,
        COALESCE(SUM(json_extract(m.data,'$.tokens.input')),0) AS ti,
        COALESCE(SUM(json_extract(m.data,'$.tokens.output')),0) AS tout,
        COALESCE(SUM(json_extract(m.data,'$.tokens.reasoning')),0) AS tr,
        COALESCE(SUM(json_extract(m.data,'$.time.completed') - json_extract(m.data,'$.time.created')),0) AS activeMs
       FROM message m WHERE json_extract(m.data,'$.role')='assistant'
       GROUP BY 1, 2 ORDER BY messages DESC`,
    )
    .all();
  const range = db
    .prepare(
      `SELECT MIN(time_created) AS minT, MAX(time_updated) AS maxT FROM session`,
    )
    .get();
  return {
    sessionCount,
    messageCount,
    partCount,
    tokens: totals,
    perProject,
    perModel,
    toolUsage,
    range,
  };
}
