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
  agent?: unknown;
  command?: unknown;
  description?: unknown;
  prompt?: unknown;
  model?: unknown;
}

/** LIKE 用エスケープ */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function parseJsonSafe<T>(s: unknown, fallback: T): T {
  try {
    return JSON.parse(typeof s === "string" ? s : "") as T;
  } catch {
    return fallback;
  }
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
        COUNT(s.id) AS sessionCount,
        MAX(s.time_updated) AS lastActive
       FROM project p LEFT JOIN session s ON s.project_id = p.id
       GROUP BY p.id ORDER BY lastActive DESC, p.id DESC`,
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
  // 同一タイムスタンプの行があっても順序が揺れないよう id を第2キーにする
  const order =
    sort === "created"
      ? `s.time_created DESC, s.id DESC`
      : `s.time_updated DESC, s.id DESC`;

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
  // 全セッション一括の ORDER BY + LIMIT では先頭セッションに枠を奪われるため、
  // session_id の索引が効く window 関数で2発（user 先頭＋全体先頭）にまとめる。
  // N+1（50件で約800ms）のラウンドトリップを避けるためのバッチ化。
  // substr(p.data,1,N) を JSON.parse すると切断位置で壊れるため、
  // json_extract で text/role だけ抜き出してから substr する。
  // また text パートは {"type":"text" で始まるため prefix 判定を先に置き、
  // 巨大な tool 出力まで json_extract でパースするのを避ける（実測 2.3 倍）。
  // prefix が崩れた非正規形はプレビューが空になるだけで一覧表示は壊さない
  if (sessions.length) {
    const ids = sessions.map((s) => String(s.id));
    const placeholders = ids.map(() => "?").join(",");
    const firstTextByRole = (userOnly: boolean): Map<string, string> => {
      // フォールバック側は role 判定が要らないため message 結合自体を省く
      const join = userOnly ? "JOIN message m ON m.id = p.message_id" : "";
      const roleCond = userOnly
        ? "AND json_extract(m.data, '$.role') = 'user'"
        : "";
      const rows = db
        .prepare(
          `SELECT session_id, text FROM (
             SELECT p.session_id AS session_id,
               substr(json_extract(p.data, '$.text'), 1, 200) AS text,
               ROW_NUMBER() OVER (
                 PARTITION BY p.session_id ORDER BY p.time_created ASC, p.id ASC
               ) AS rn
             FROM part p ${join}
             WHERE p.session_id IN (${placeholders})
               AND substr(p.data,1,14) = '{"type":"text"'
               AND json_extract(p.data, '$.type') = 'text'
               AND typeof(json_extract(p.data, '$.text')) = 'text'
               AND json_extract(p.data, '$.text') <> ''
               ${roleCond}
           ) WHERE rn = 1`,
        )
        .all(...ids);
      const map = new Map<string, string>();
      for (const r of rows) {
        if (typeof r.text === "string" && r.text) {
          map.set(String(r.session_id), r.text);
        }
      }
      return map;
    };
    let userMap = new Map<string, string>();
    let fallbackMap = new Map<string, string>();
    try {
      userMap = firstTextByRole(true);
      fallbackMap = firstTextByRole(false);
    } catch {
      // プレビュー失敗は一覧自体を壊さない（空文字のまま）
    }
    for (const s of sessions) {
      const sid = String(s.id);
      s.preview = userMap.get(sid) || fallbackMap.get(sid) || "";
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
    const inputStr =
      typeof st.input === "string"
        ? st.input
        : st.input
          ? JSON.stringify(st.input)
          : "";
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
  } else if (raw.type === "subtask") {
    // /review・/init 等のカスタムコマンド実行記録。prompt は指示文本文のため text と同じ caps。
    const t = truncate(typeof raw.prompt === "string" ? raw.prompt : "");
    base.agent = typeof raw.agent === "string" ? raw.agent : "";
    base.command = typeof raw.command === "string" ? raw.command : "";
    base.description =
      typeof raw.description === "string" ? raw.description : "";
    base.model = raw.model ?? null;
    base.prompt = t.text;
    if (t.truncated) {
      base.promptTruncated = true;
      base.promptFullLength = t.fullLength;
    }
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

  // 生 JSON への LIKE は "type" / "state" 等のキー名にも当たるため、
  // 安価な prefilter（p.data LIKE）で候補を絞ってから表示対象フィールドだけを照合する。
  // tool は表示される state（input/output/metadata 等）全体、patch は files が対象。
  // fieldCond は ? を4個取り、termConds は prefilter を含め1語あたり5パラメータになる。
  const fieldCond = `(
      (json_extract(p.data, '$.type') IN ('text','reasoning') AND json_extract(p.data, '$.text') LIKE ? ESCAPE '\\')
      OR (json_extract(p.data, '$.type') = 'tool' AND (
        COALESCE(json_extract(p.data, '$.title'), '') LIKE ? ESCAPE '\\'
        OR json_extract(p.data, '$.state') LIKE ? ESCAPE '\\'
      ))
      OR (json_extract(p.data, '$.type') = 'patch' AND json_extract(p.data, '$.files') LIKE ? ESCAPE '\\')
    )`;
  const termConds = terms
    .map(() => `(p.data LIKE ? ESCAPE '\\' AND ${fieldCond})`)
    .join(" AND ");
  const params: (string | number)[] = terms.flatMap((t) => {
    const pattern = `%${escapeLike(t)}%`;
    // 生 JSON では " や \ がエスケープされているため prefilter 側も JSON 表記に合わせる
    const prefilter = `%${escapeLike(JSON.stringify(t).slice(1, -1))}%`;
    return [prefilter, pattern, pattern, pattern, pattern];
  });
  const projCond = project ? `AND s.project_id = ?` : "";
  if (project) params.push(project);

  // 総件数は通常この取得クエリ側で同時に取る。ここは offset 超過で 0 件のときのみ使う
  const countSql = `SELECT COUNT(*) AS c FROM part p JOIN session s ON s.id = p.session_id
    WHERE ${termConds} ${projCond}`;

  // 先に該当 part の id だけを並べ替えて 50 件に絞り、JSON 抜き出しはその 50 件にだけ行う
  // （全ヒット行に対して json_extract/substr すると巨大 JSON で数秒かかる）。
  // 総件数は COUNT(*) OVER () で同一スキャンから取る（従来は COUNT 用に同じ全走査を
  // もう一度実行しており、検索 1 回で 2 回スキャンしていた）。
  // COUNT(*) OVER () は LIMIT 適用前に全ヒット行へ計算される
  const sql = `WITH picked AS MATERIALIZED (
    SELECT p.id AS pid, p.time_created AS ptc, COUNT(*) OVER () AS total
    FROM part p JOIN session s ON s.id = p.session_id
    WHERE ${termConds} ${projCond}
    ORDER BY p.time_created DESC, p.id DESC LIMIT ? OFFSET ?
  )
  SELECT p.session_id, p.message_id, p.id AS part_id, p.time_created,
      picked.total AS total,
      json_extract(p.data, '$.type') AS ptype,
      json_extract(p.data, '$.tool') AS ptool,
      COALESCE(json_extract(p.data, '$.title'), json_extract(p.data, '$.state.title')) AS ptitle,
      json_extract(m.data, '$.role') AS mrole,
      substr(json_extract(p.data, '$.text'), 1, 8000) AS t_text,
      substr(json_extract(p.data, '$.state.input'), 1, 4000) AS t_input,
      substr(json_extract(p.data, '$.state.output'), 1, 8000) AS t_output,
      substr(json_extract(p.data, '$.state.metadata.output'), 1, 8000) AS t_metaout,
      substr(json_extract(p.data, '$.files'), 1, 2000) AS t_files,
      s.title AS session_title, s.directory, s.project_id
    FROM picked
    JOIN part p ON p.id = picked.pid
    JOIN session s ON s.id = p.session_id
    LEFT JOIN message m ON m.id = p.message_id
    ORDER BY picked.ptc DESC, picked.pid DESC`;
  const rows = db.prepare(sql).all(...params, Number(limit), Number(offset));

  let total = rows.length ? Number(rows[0]?.total ?? 0) : 0;
  // ヒットが 0 件でも offset が 1 ページ目でなければ総件数が 0 とは限らない
  if (rows.length === 0 && offset > 0) {
    total = (db.prepare(countSql).get(...params)?.c as number) ?? 0;
  }

  const lowerTerms = terms.map((t) => t.toLowerCase());
  const hits = rows.map((r) => {
    // substr(p.data,1,N) を JSON.parse すると切断で壊れるため、
    // SQL 側で json_extract＋substr 済みの断片からスニペット源を組み立てる
    const ptype = typeof r.ptype === "string" ? r.ptype : "unknown";
    const ptool = typeof r.ptool === "string" ? r.ptool : null;
    const ptitle = typeof r.ptitle === "string" ? r.ptitle : null;
    const role = typeof r.mrole === "string" && r.mrole ? r.mrole : "unknown";
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    let full = "";
    if (ptype === "text" || ptype === "reasoning") {
      full = str(r.t_text);
    } else if (ptype === "tool") {
      full = [ptitle || "", str(r.t_input), str(r.t_output) || str(r.t_metaout)]
        .filter(Boolean)
        .join("\n");
    } else if (ptype === "patch") {
      full = str(r.t_files) ? `patch ${str(r.t_files)}` : "patch";
    }
    // パース済み断片内でスニペット生成
    const snippet = makeSnippet(full, lowerTerms);
    return {
      session_id: r.session_id,
      session_title: r.session_title,
      directory: r.directory,
      project_id: r.project_id,
      message_id: r.message_id,
      part_id: r.part_id,
      part_type: ptype,
      tool: ptool,
      title: ptitle,
      role,
      time_created: r.time_created,
      snippet,
    };
  });
  return { total, hits };
}

function makeSnippet(full: string, lowerTerms: string[], radius = 120): string {
  if (!full) return "";
  const lower = full.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const t of lowerTerms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      bestLen = t.length;
    }
  }
  if (best === -1) return full.slice(0, radius * 2);
  const start = Math.max(0, best - radius);
  const end = Math.min(full.length, best + radius + bestLen);
  const prefix = start > 0 ? "…" : "";
  return prefix + full.slice(start, end);
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
  // 全行を JS に載せず SQL 側で日別集計する（message 件数が増えても転送量は日数分）。
  // 日付境界はサーバーローカル日付（'localtime'）で切る。
  const sCond = project ? `WHERE project_id = ?` : "";
  const sParams: string[] = project ? [project] : [];
  const sessionDays = db
    .prepare(
      `SELECT date(time_created / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS sessions, COALESCE(SUM(cost), 0) AS cost
       FROM session ${sCond} GROUP BY day`,
    )
    .all(...sParams);
  const mCond = project
    ? `JOIN session s ON s.id = m.session_id WHERE s.project_id = ?`
    : "";
  const mParams: string[] = project ? [project] : [];
  const messageDays = db
    .prepare(
      `SELECT date(m.time_created / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS messages
       FROM message m ${mCond} GROUP BY day`,
    )
    .all(...mParams);
  const tCond = project ? `WHERE project_id = ?` : "";
  const tParams: string[] = project ? [project] : [];
  const titleRows = db
    .prepare(
      `SELECT day, title FROM (
         SELECT date(time_created / 1000, 'unixepoch', 'localtime') AS day, title,
           ROW_NUMBER() OVER (
             PARTITION BY date(time_created / 1000, 'unixepoch', 'localtime')
             ORDER BY time_created DESC, id DESC
           ) AS rn
         FROM session ${tCond}
       ) WHERE rn <= 5 ORDER BY day, rn`,
    )
    .all(...tParams);

  const byDay = new Map<
    string,
    {
      date: string;
      sessions: number;
      messages: number;
      cost: number;
      titles: string[];
    }
  >();
  const entry = (day: unknown) => {
    const k = typeof day === "string" ? day : "";
    if (!k) return null;
    let e = byDay.get(k);
    if (!e) {
      e = { date: k, sessions: 0, messages: 0, cost: 0, titles: [] };
      byDay.set(k, e);
    }
    return e;
  };
  for (const s of sessionDays) {
    const e = entry(s.day);
    if (!e) continue;
    e.sessions += Number(s.sessions || 0);
    e.cost += Number(s.cost || 0);
  }
  for (const m of messageDays) {
    const e = entry(m.day);
    if (!e) continue;
    e.messages += Number(m.messages || 0);
  }
  for (const t of titleRows) {
    const e = entry(t.day);
    if (!e || e.titles.length >= 5) continue;
    if (t.title != null && t.title !== "") e.titles.push(String(t.title));
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
       GROUP BY s.project_id ORDER BY sessions DESC, s.project_id DESC`,
    )
    .all();
  // toolUsage は json_extract(data,'$.type') を全 part に適用すると、巨大な tool 出力まで
  // JSON パースして数秒かかる（実測 11GB DB で約 3 秒）。part.data は
  // {"type":"tool","tool":"...",...} の並びで始まるため、先頭 160 バイトだけを読み
  // （prefix の substr は行全体を実体化しない）、文字列処理で tool 名を切り出す。
  // 正規形でない行（旧形式でキー順が違う等）だけ json_extract にフォールバックする
  const TOOL_HEAD_PREFIX = '{"type":"tool","tool":"';
  const toolHeads = db
    .prepare(
      `SELECT id, substr(data,1,160) AS h FROM part
       WHERE substr(data,1,14)='{"type":"tool"'`,
    )
    .all();
  const toolCounts = new Map<string, number>();
  const fallbackIds: string[] = [];
  const addTool = (tool: unknown, c: unknown) => {
    const name = typeof tool === "string" && tool !== "" ? tool : "(unknown)";
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + Number(c ?? 0));
  };
  for (const r of toolHeads) {
    const head = String(r.h ?? "");
    if (!head.startsWith(TOOL_HEAD_PREFIX)) {
      fallbackIds.push(String(r.id));
      continue;
    }
    const start = TOOL_HEAD_PREFIX.length;
    const end = head.indexOf('"', start);
    // 先頭 160 バイト内に閉じ引用符が無いのは異常データ。フォールバックで正確に取る
    if (end <= start) {
      fallbackIds.push(String(r.id));
      continue;
    }
    addTool(head.slice(start, end), 1);
  }
  if (fallbackIds.length > 0) {
    // SQLite のバインド変数上限に当たらないよう分割して問い合わせる
    const CHUNK = 500;
    for (let i = 0; i < fallbackIds.length; i += CHUNK) {
      const chunk = fallbackIds.slice(i, i + CHUNK);
      const holes = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT json_extract(data,'$.tool') AS tool, COUNT(*) AS c FROM part
           WHERE id IN (${holes}) GROUP BY 1`,
        )
        .all(...chunk);
      for (const r of rows) addTool(r.tool, r.c);
    }
  }
  const toolUsage = [...toolCounts.entries()]
    .map(([tool, c]) => ({ tool, c }))
    .sort((a, b) => b.c - a.c || a.tool.localeCompare(b.tool))
    .slice(0, 20);
  // モデル別集計は message 単位で行う。session.model は最終選択モデルのため、
  // マルチモデルセッション（62件中4件）のコスト按分に使うと誤集計になる。
  // message.data は role が先頭付近（実測 最長 46 バイト目）にあるため、先頭 512 バイトの
  // LIKE で assistant を絞ってから json_extract する。全行（user の巨大データを含む
  // 569MB）へ json_extract する従来形は 0.5〜0.8 秒かかっていた
  const perModel = db
    .prepare(
      `WITH assistant_msgs AS MATERIALIZED (
         SELECT session_id, data FROM message
         WHERE substr(data,1,512) LIKE '%"role":"assistant"%'
           AND json_extract(data,'$.role')='assistant'
       )
       SELECT json_extract(data,'$.providerID') AS provider,
         json_extract(data,'$.modelID') AS id,
         COUNT(*) AS messages,
         COUNT(DISTINCT session_id) AS sessions,
         COALESCE(SUM(json_extract(data,'$.cost')),0) AS cost,
         COALESCE(SUM(json_extract(data,'$.tokens.input')),0) AS ti,
         COALESCE(SUM(json_extract(data,'$.tokens.output')),0) AS tout,
         COALESCE(SUM(json_extract(data,'$.tokens.reasoning')),0) AS tr,
         COALESCE(SUM(json_extract(data,'$.time.completed') - json_extract(data,'$.time.created')),0) AS activeMs
       FROM assistant_msgs GROUP BY 1, 2 ORDER BY messages DESC, provider, id`,
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
