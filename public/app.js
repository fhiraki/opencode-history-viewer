const $ = (id) => document.getElementById(id);

const state = {
  tab: "sessions",
  sessions: [],
  total: 0,
  limit: 50,
  offset: 0,
  q: "",
  project: "",
  sort: "updated",
  selectedId: null,
  searchQ: "",
  searchOffset: 0,
  searchTotal: 0,
  timelineDay: "",
  highlight: "",
};

function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  return d.toLocaleString("ja-JP", { hour12: false });
}
// セッションの model（JSON文字列またはプレーン文字列）を {provider, id, variant} に正規化
function parseModel(model) {
  if (!model) return null;
  try {
    const o = typeof model === "string" ? JSON.parse(model) : model;
    if (o && typeof o === "object") {
      return {
        provider: o.providerID || "",
        id: o.id || o.modelID || "",
        variant: o.variant || "",
      };
    }
  } catch {
    // JSON ではないのでプレーン文字列として扱う
  }
  return { provider: "", id: String(model), variant: "" };
}
function fmtCost(c) {
  const v = Number(c || 0);
  if (v <= 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtCount(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${v}`;
}
// 同日なら「9/18 0:13 → 1:08」、跨ぎなら両日＋所要時間を付ける
function fmtRange(from, to) {
  const a = new Date(Number(from));
  const b = new Date(Number(to));
  const d = (x) => `${x.getMonth() + 1}/${x.getDate()}`;
  const t = (x) => `${x.getHours()}:${String(x.getMinutes()).padStart(2, "0")}`;
  const range =
    a.toDateString() === b.toDateString()
      ? `${d(a)} ${t(a)} → ${t(b)}`
      : `${d(a)} ${t(a)} → ${d(b)} ${t(b)}`;
  const mins = Math.max(0, Math.round((b - a) / 60000));
  let dur = `${mins}分`;
  if (mins >= 1440) {
    dur = `${Math.floor(mins / 1440)}日${Math.floor((mins % 1440) / 60)}時間`;
  } else if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    dur = m ? `${h}時間${m}分` : `${h}時間`;
  }
  return `${range}（${dur}）`;
}
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function highlightHtml(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const e = esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      out = out.replace(new RegExp(`(${e})`, "gi"), "<mark>$1</mark>");
    } catch {}
  }
  return out;
}
function searchTerms() {
  return (state.highlight || "").split(/\s+/).filter(Boolean).slice(0, 8);
}

// ---------- シンタックスハイライト（依存なし・自前トークナイザ） ----------
const LANG_ALIASES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyi: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  jsonc: "json",
  xml: "html",
  vue: "html",
  svelte: "html",
  astro: "html",
  scss: "css",
  less: "css",
  toml: "ini",
  cfg: "ini",
  patch: "diff",
  txt: "plaintext",
  text: "plaintext",
};
const EXT_TO_LANG = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyi: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  xml: "html",
  vue: "html",
  svelte: "html",
  astro: "html",
  css: "css",
  scss: "css",
  less: "css",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  diff: "diff",
  patch: "diff",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
};
const CLIKE_KEYWORDS = [
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "async",
  "await",
  "of",
  "from",
  "as",
  "package",
  "public",
  "private",
  "protected",
  "final",
  "virtual",
  "override",
  "int",
  "long",
  "double",
  "float",
  "char",
  "short",
  "unsigned",
  "signed",
  "struct",
  "union",
  "typedef",
  "sizeof",
  "extern",
  "register",
  "goto",
  "namespace",
  "template",
  "typename",
  "nullptr",
  "constexpr",
  "decltype",
  "noexcept",
  "friend",
  "operator",
  "throws",
  "synchronized",
  "record",
  "concept",
  "requires",
  "interface",
  "type",
  "enum",
  "readonly",
  "declare",
  "abstract",
  "satisfies",
  "keyof",
  "infer",
  "never",
  "unknown",
  "any",
  "string",
  "number",
  "boolean",
  "symbol",
  "bigint",
  "object",
  "Promise",
  "console",
];
const PYTHON_KEYWORDS = [
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "print",
  "self",
];
const BASH_KEYWORDS = [
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "select",
  "case",
  "esac",
  "break",
  "continue",
  "return",
  "exit",
  "export",
  "local",
  "readonly",
  "declare",
  "unset",
  "eval",
  "exec",
  "source",
  "trap",
  "shift",
  "set",
  "echo",
  "printf",
  "cd",
  "pwd",
  "ls",
  "cat",
  "grep",
  "sed",
  "awk",
  "find",
  "xargs",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tar",
  "curl",
  "wget",
  "git",
  "npm",
  "node",
  "npx",
  "python",
  "python3",
  "pip",
  "ssh",
  "test",
];
const SQL_KEYWORDS = new Set(
  "select from where join left right inner outer on group by order having limit offset insert into values update set delete create table index view drop alter add column as and or not null primary key foreign references distinct count sum avg min max like in is between union all case when then else end asc desc".split(
    " ",
  ),
);
const YAML_CONSTANTS = new Set(
  "true false null yes no on off True False Null None Yes No On Off TRUE FALSE NULL YES NO ON OFF".split(
    " ",
  ),
);

function keywordRule(words) {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  return [new RegExp(`\\b(?:${sorted.join("|")})\\b`), "k"];
}

// rules: [正規表現, クラス名または分類関数(word, offset, src)] の配列。sticky マッチで先頭から順に試す
function makeLexer(rules) {
  const compiled = rules.map(([re, cls, extra]) => [
    new RegExp(re.source, extra ? `y${extra}` : "y"),
    cls,
  ]);
  return (src) => {
    let out = "";
    let pos = 0;
    while (pos < src.length) {
      let advanced = false;
      for (const [re, cls] of compiled) {
        re.lastIndex = pos;
        const m = re.exec(src);
        if (m && m[0].length > 0) {
          const clsName = typeof cls === "function" ? cls(m[0], pos, src) : cls;
          out += clsName
            ? `<span class="tok-${clsName}">${esc(m[0])}</span>`
            : esc(m[0]);
          pos += m[0].length;
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        out += esc(src[pos]);
        pos += 1;
      }
    }
    return out;
  };
}

const WS_RULE = [/\s+/, null];
const DQ_RULE = [/"(?:[^"\\\n]|\\.)*(?:"|$)/, "s"];
const SQ_RULE = [/'(?:[^'\\\n]|\\.)*(?:'|$)/, "s"];
const HEX_NUM_RULE = [/\b0x[\da-fA-F_]+\b/, "n"];
const DEC_NUM_RULE = [/\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, "n"];
const IDENT_RULE = [/[A-Za-z_$][\w$]*/, null];
const FUNC_CALL_RULE = [/[A-Za-z_$][\w$]*(?=\s*\()/, "f"];

function clikeLexer() {
  return makeLexer([
    WS_RULE,
    [/\/\/[^\n]*/, "c"],
    [/\/\*[\s\S]*?(?:\*\/|$)/, "c"],
    DQ_RULE,
    SQ_RULE,
    [/`(?:[^`\\]|\\.)*(?:`|$)/, "s"],
    HEX_NUM_RULE,
    DEC_NUM_RULE,
    keywordRule(CLIKE_KEYWORDS),
    FUNC_CALL_RULE,
    IDENT_RULE,
  ]);
}
function pythonLexer() {
  return makeLexer([
    WS_RULE,
    [/#[^\n]*/, "c"],
    [/"""[\s\S]*?(?:"""|$)/, "s"],
    [/'''[\s\S]*?(?:'''|$)/, "s"],
    DQ_RULE,
    SQ_RULE,
    HEX_NUM_RULE,
    DEC_NUM_RULE,
    keywordRule(PYTHON_KEYWORDS),
    [/@[\w.]+/, "f"],
    [/[A-Za-z_]\w*(?=\s*\()/, "f"],
    [/[A-Za-z_]\w*/, null],
  ]);
}
function bashLexer() {
  return makeLexer([
    WS_RULE,
    DQ_RULE,
    [/'[^'\n]*(?:'|$)/, "s"],
    [/\$\{[^}\n]*\}|\$[\w?*#@!$~-]/, "var"],
    [/#[^\n]*/, "c"],
    keywordRule(BASH_KEYWORDS),
    [/\b\d+\b/, "n"],
    [/[A-Za-z_][\w.-]*/, null],
  ]);
}
function jsonLexer() {
  return makeLexer([
    WS_RULE,
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"],
    [/"(?:[^"\\]|\\.)*"(?:"|$)/, "s"],
    [/\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, "n"],
    [/\b(?:true|false|null)\b/, "k"],
  ]);
}
function htmlLexer() {
  return makeLexer([
    WS_RULE,
    [/<!--[\s\S]*?(?:-->|$)/, "c"],
    [/<\/?[A-Za-z][\w:.-]*/, "tag"],
    [/\/?>/, "tag"],
    [/[A-Za-z_:][\w:.-]*(?=\s*=(?!=))/, "attr"],
    DQ_RULE,
    SQ_RULE,
  ]);
}
function cssLexer() {
  return makeLexer([
    WS_RULE,
    [/\/\*[\s\S]*?(?:\*\/|$)/, "c"],
    DQ_RULE,
    SQ_RULE,
    [/@[\w-]+/, "k"],
    [/[A-Za-z-]+(?=\s*:)/, "key"],
    [/#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{4}|[\da-fA-F]{3})\b/, "n"],
    [/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/, "n"],
    [/[A-Za-z-]+/, null],
  ]);
}
function sqlLexer() {
  return makeLexer([
    WS_RULE,
    [/--[^\n]*/, "c"],
    [/\/\*[\s\S]*?(?:\*\/|$)/, "c"],
    [/'(?:[^']|'')*(?:'|$)/, "s"],
    [/"(?:[^"]|"")*(?:"|$)/, null],
    [/\b\d+(?:\.\d+)?\b/, "n"],
    [
      /[A-Za-z_][\w$]*/,
      (word, at, src) => {
        if (SQL_KEYWORDS.has(word.toLowerCase())) return "k";
        return /^\s*\(/.test(src.slice(at + word.length, at + word.length + 8))
          ? "f"
          : null;
      },
    ],
  ]);
}
function yamlLexer() {
  return makeLexer([
    WS_RULE,
    [/#[^\n]*/, "c"],
    DQ_RULE,
    SQ_RULE,
    [/[A-Za-z0-9_./-]+(?=:(?:[ \t]|$))/, "key", "m"],
    [/\b\d+(?:\.\d+)?\b/, "n"],
    [/[A-Za-z]+/, (word) => (YAML_CONSTANTS.has(word) ? "k" : null)],
    [/[A-Za-z0-9_./-]+/, null],
  ]);
}
function iniLexer() {
  return makeLexer([
    WS_RULE,
    [/[;#][^\n]*/, "c"],
    [/\[[^\]\n]*\]?/, "k"],
    [/[^\s=;#[\n][^=\n]*?(?=\s*=)/, "key"],
    [/\b\d+(?:\.\d+)?\b/, "n"],
  ]);
}

const CLIKE_LANGS = [
  "javascript",
  "typescript",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "php",
  "swift",
  "kotlin",
];
const HIGHLIGHTERS = Object.fromEntries(
  CLIKE_LANGS.map((lang) => [lang, clikeLexer()]),
);
HIGHLIGHTERS.python = pythonLexer();
HIGHLIGHTERS.bash = bashLexer();
HIGHLIGHTERS.json = jsonLexer();
HIGHLIGHTERS.html = htmlLexer();
HIGHLIGHTERS.css = cssLexer();
HIGHLIGHTERS.sql = sqlLexer();
HIGHLIGHTERS.yaml = yamlLexer();
HIGHLIGHTERS.ini = iniLexer();

function highlightDiff(src) {
  return src
    .split("\n")
    .map((line) => {
      let cls = null;
      if (/^(?:@@ |diff |index |--- |\+\+\+ |commit )/.test(line)) cls = "hunk";
      else if (line.startsWith("+")) cls = "add";
      else if (line.startsWith("-")) cls = "del";
      const e = esc(line);
      return cls ? `<span class="tok-${cls}">${e}</span>` : e;
    })
    .join("\n");
}

function highlightTokens(raw, lang) {
  if (lang === "diff") return highlightDiff(raw);
  const lex = HIGHLIGHTERS[lang];
  return lex ? lex(raw) : esc(raw);
}

function normalizeLang(info, code) {
  if (info) {
    if (LANG_ALIASES[info]) return LANG_ALIASES[info];
    if (HIGHLIGHTERS[info]) return info;
    return "plaintext";
  }
  const trimmed = code.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // JSON ではないので次の判定へ
    }
  }
  const pmLines = trimmed
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(?:\+\+\+|---)/.test(l));
  if (/^(?:@@ |diff |--- |\+\+\+ )/m.test(trimmed) || pmLines.length >= 2) {
    return "diff";
  }
  return "plaintext";
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ハイライト済み HTML のタグ部分を避けて検索語だけ <mark> 化する
function markTermsHtml(html, terms) {
  const clean = [...new Set(terms.filter(Boolean))].slice(0, 8);
  if (!clean.length) return html;
  const pattern = new RegExp(
    `(${clean.map((t) => escapeRegExp(esc(t))).join("|")})`,
    "gi",
  );
  return html
    .split(/(<[^>]*>)/g)
    .map((chunk, i) =>
      i % 2 === 1 ? chunk : chunk.replace(pattern, "<mark>$1</mark>"),
    )
    .join("");
}

const FENCE_RE = /```([^\n]*)\n([\s\S]*?)(?:\n```|```|$)/g;
function renderInlineCode(escapedHtml) {
  return escapedHtml.replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>');
}
function renderProse(text, terms) {
  FENCE_RE.lastIndex = 0;
  let html = "";
  let last = 0;
  let m = FENCE_RE.exec(text);
  while (m !== null) {
    if (m.index > last) {
      html += renderInlineCode(esc(text.slice(last, m.index)));
    }
    const code = m[2].replace(/\n$/, "");
    if (!code) {
      html += renderInlineCode(esc(m[0]));
    } else {
      const lang = normalizeLang((m[1] || "").trim().toLowerCase(), code);
      const label = lang === "plaintext" ? "TEXT" : lang.toUpperCase();
      html += `<div class="codeblock"><div class="codelang">${esc(label)}</div><pre><code>${highlightTokens(code, lang)}</code></pre></div>`;
    }
    last = m.index + m[0].length;
    m = FENCE_RE.exec(text);
  }
  if (last < text.length) {
    html += renderInlineCode(esc(text.slice(last)));
  }
  return markTermsHtml(html, terms);
}

function prettyJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// read/edit/write の filePath から出力の言語を推定する（他ツールはプレーン表示）
function toolOutputLang(p) {
  if (p.tool !== "read" && p.tool !== "edit" && p.tool !== "write") {
    return "plaintext";
  }
  try {
    const input = JSON.parse(p.input || "{}");
    const filePath = typeof input.filePath === "string" ? input.filePath : "";
    const base = filePath.split("/").pop() || "";
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    return (ext && EXT_TO_LANG[ext]) || "plaintext";
  } catch {
    return "plaintext";
  }
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- タブ ----------
document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab));
});
function switchTab(name) {
  state.tab = name;
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab").forEach((s) => {
    s.classList.toggle("active", s.id === `tab-${name}`);
  });
  moveTabIndicator();
  if (name === "timeline") loadTimeline();
  if (name === "stats") loadStats();
  if (name === "search") loadSearch();
}

// iOS 風セグメントコントロール: 選択中ボタンへインジケーターをスライドさせる
function moveTabIndicator() {
  const nav = document.querySelector(".tabs");
  const active = nav?.querySelector("button.active");
  const indicator = nav?.querySelector(".tabs-indicator");
  if (!nav || !active || !indicator) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

// ---------- プロジェクト ----------
async function loadProjects() {
  const { projects } = await api("/api/projects");
  const sel = $("projectFilter");
  sel.innerHTML = `<option value="">すべてのプロジェクト</option>`;
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.id;
    const label = p.worktree || p.id;
    o.textContent = `${label} (${p.sessionCount})`;
    sel.appendChild(o);
  }
}

// ---------- セッション一覧 ----------
async function loadSessions() {
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
    q: state.q,
    project: state.project,
    sort: state.sort,
  });
  if (state.timelineDay) {
    const start = new Date(`${state.timelineDay}T00:00:00`).getTime();
    const end = new Date(`${state.timelineDay}T23:59:59.999`).getTime();
    params.set("from", String(start));
    params.set("to", String(end));
  }
  const data = await api(`/api/sessions?${params}`);
  state.sessions = data.sessions;
  state.total = data.total;
  renderSessionList();
}

function renderSessionList() {
  const el = $("sessionList");
  el.innerHTML = "";
  $("sessionCount").textContent =
    `${state.total} 件${state.timelineDay ? `（${state.timelineDay}）` : ""}`;
  $("pageInfo").textContent =
    `${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} / ${state.total}`;
  $("prevPage").disabled = state.offset <= 0;
  $("nextPage").disabled = state.offset + state.limit >= state.total;
  for (const s of state.sessions) {
    const b = document.createElement("button");
    b.className = `session-item${s.id === state.selectedId ? " selected" : ""}`;
    b.innerHTML = `
      <div class="title">${esc(s.title || "(無題)")}</div>
      <div class="meta">${esc(s.directory || "")} ・ ${fmtTime(s.time_updated)} ・ ${s.messageCount} msgs</div>
      ${s.preview ? `<div class="preview">${esc(s.preview.slice(0, 160))}</div>` : ""}`;
    b.addEventListener("click", () => selectSession(s.id));
    el.appendChild(b);
  }
  if (!state.sessions.length)
    el.innerHTML = `<p class="muted">該当するセッションがありません。</p>`;
}

async function selectSession(id, highlight = "") {
  state.selectedId = id;
  state.highlight = highlight;
  renderSessionList();
  const el = $("sessionDetail");
  el.innerHTML = `<p class="muted">読み込み中…</p>`;
  try {
    const data = await api(`/api/session/${encodeURIComponent(id)}`);
    el.innerHTML = renderDetail(data, searchTerms());
    el.scrollTop = 0;
  } catch (e) {
    el.innerHTML = `<p>読み込みに失敗しました: ${esc(e.message)}</p>`;
  }
}

function renderDetail({ session, messages }, terms) {
  const model = parseModel(session.model);
  const modelText = model
    ? `${model.provider ? `${model.provider}/` : ""}${model.id}${model.variant && model.variant !== "default" ? ` ・ ${model.variant}` : ""}`
    : "";
  const cost = Number(session.cost || 0);
  const tokIn = Number(session.tokens_input || 0);
  const tokOut = Number(session.tokens_output || 0);
  const tokReason = Number(session.tokens_reasoning || 0);
  const chips = [
    modelText
      ? `<span class="chip model" title="${esc(session.model || "")}"><span class="chip-label">モデル</span>${esc(modelText)}</span>`
      : "",
    session.agent
      ? `<span class="chip"><span class="chip-label">エージェント</span>${esc(session.agent)}</span>`
      : "",
    `<span class="chip cost" title="正確な値: $${cost}"><span class="chip-label">コスト</span>${esc(fmtCost(cost))}</span>`,
    `<span class="chip" title="入力 ${tokIn.toLocaleString()} / 出力 ${tokOut.toLocaleString()} / 推論 ${tokReason.toLocaleString()}"><span class="chip-label">トークン</span>${esc(fmtCount(tokIn + tokOut + tokReason))}</span>`,
    `<span class="chip"><span class="chip-label">発言</span>${messages.length}</span>`,
  ].join("");
  const head = `
    <h2>${esc(session.title || "(無題)")}</h2>
    <div class="chips">${chips}</div>
    <div class="muted sub-line">${esc(session.directory || "")} ・ ${esc(fmtRange(session.time_created, session.time_updated))}</div>`;
  const body = messages
    .map((m) => {
      const parts = m.parts
        .map((p) => renderPart(p, terms))
        .filter(Boolean)
        .join("");
      if (!parts) return "";
      return `<div class="msg">
      <div class="msg-head"><span class="role ${esc(m.role)}">${esc(m.role)}</span>
      <span class="time">${fmtTime(m.time_created)}</span>
      ${m.tokens ? `<span class="time">tok ${m.tokens.total ?? ""}</span>` : ""}</div>
      ${parts}</div>`;
    })
    .join("");
  return head + body;
}

function renderPart(p, terms) {
  if (p.type === "step-start" || p.type === "step-finish") return "";
  if (p.type === "text" || p.type === "reasoning") {
    if (p.type === "reasoning") {
      return `<details class="part"><summary>推論過程（クリックで展開）</summary><div class="part-body">${renderProse(p.text || "", terms)}</div></details>`;
    }
    return `<div class="part"><div class="part-body prose">${renderProse(p.text || "", terms)}${p.truncated ? `<div class="muted">…（${p.fullLength} 文字のため省略）</div>` : ""}</div></div>`;
  }
  if (p.type === "tool") {
    const label =
      `${esc(p.tool)} ${esc(p.title || "")} ${esc(p.status || "")}`.trim();
    const inputHtml = markTermsHtml(
      highlightTokens(prettyJson(p.input || ""), "json"),
      terms,
    );
    const outputHtml = markTermsHtml(
      highlightTokens((p.output || "").slice(0, 8000), toolOutputLang(p)),
      terms,
    );
    return `<details class="part" open><summary>🔧 ${label}</summary>
      <div class="part-head">入力</div><div class="part-body">${inputHtml}</div>
      <div class="part-head">出力${p.outputTruncated ? `（${p.outputFullLength} 文字中一部）` : ""}</div><div class="part-body">${outputHtml}</div>
    </details>`;
  }
  if (p.type === "patch") {
    return `<div class="part"><div class="part-head">patch</div><div class="part-body">${esc((p.files || []).join("\n"))}</div></div>`;
  }
  if (p.type === "compaction")
    return `<div class="part"><div class="part-head">compaction</div></div>`;
  return `<div class="part"><div class="part-head">${esc(p.type)}</div><div class="part-body">${esc(p.rawText || "")}</div></div>`;
}

$("prevPage").addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadSessions();
});
$("nextPage").addEventListener("click", () => {
  if (state.offset + state.limit < state.total) state.offset += state.limit;
  loadSessions();
});
$("projectFilter").addEventListener("change", (e) => {
  state.project = e.target.value;
  state.offset = 0;
  loadSessions();
});
$("sortSelect").addEventListener("change", (e) => {
  state.sort = e.target.value;
  state.offset = 0;
  loadSessions();
});
let sessionFilterTimer;
$("sessionFilter").addEventListener("input", (e) => {
  clearTimeout(sessionFilterTimer);
  sessionFilterTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.offset = 0;
    loadSessions();
  }, 300);
});

// ---------- 全文検索 ----------
async function runSearch() {
  const q = $("searchInput").value.trim();
  state.searchQ = q;
  state.searchOffset = 0;
  await loadSearch();
}
async function loadSearch() {
  const box = $("searchResults");
  if (!state.searchQ) {
    box.innerHTML = `<p class="muted">キーワードを入力して検索してください。</p>`;
    $("searchCount").textContent = "";
    $("searchPageInfo").textContent = "";
    $("searchPrev").disabled = true;
    $("searchNext").disabled = true;
    return;
  }
  box.innerHTML = `<p class="muted">検索中…</p>`;
  const params = new URLSearchParams({
    q: state.searchQ,
    limit: "50",
    offset: String(state.searchOffset),
    project: state.project,
  });
  const data = await api(`/api/search?${params}`);
  state.searchTotal = data.total;
  $("searchCount").textContent = `${data.total} 件`;
  $("searchPageInfo").textContent =
    `${state.searchOffset + 1}–${Math.min(state.searchOffset + 50, data.total)} / ${data.total}`;
  $("searchPrev").disabled = state.searchOffset <= 0;
  $("searchNext").disabled = state.searchOffset + 50 >= data.total;
  box.innerHTML = "";
  const terms = state.searchQ.split(/\s+/).filter(Boolean);
  for (const h of data.hits) {
    const d = document.createElement("div");
    d.className = "hit";
    d.innerHTML = `
      <div><strong>${esc(h.session_title || "(無題)")}</strong>
      <span class="muted">［${esc(h.part_type)}${h.tool ? `:${esc(h.tool)}` : ""}］${fmtTime(h.time_created)}</span></div>
      <div class="muted">${esc(h.directory || "")}</div>
      <div class="snippet">${highlightHtml(h.snippet || "", terms)}</div>`;
    d.addEventListener("click", async () => {
      switchTab("sessions");
      await selectSession(h.session_id, state.searchQ);
    });
    box.appendChild(d);
  }
  if (!data.hits.length)
    box.innerHTML = `<p class="muted">見つかりませんでした。</p>`;
}
$("searchBtn").addEventListener("click", runSearch);
$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
$("searchPrev").addEventListener("click", () => {
  state.searchOffset = Math.max(0, state.searchOffset - 50);
  loadSearch();
});
$("searchNext").addEventListener("click", () => {
  if (state.searchOffset + 50 < state.searchTotal) state.searchOffset += 50;
  loadSearch();
});
// ---------- タイムライン ----------
async function loadTimeline() {
  const el = $("timeline");
  el.innerHTML = `<p class="muted">読み込み中…</p>`;
  const params = new URLSearchParams({ project: state.project });
  const { days } = await api(`/api/timeline?${params}`);
  el.innerHTML = "";
  if (!days.length) {
    el.innerHTML = `<p class="muted">データがありません。</p>`;
    return;
  }
  const maxMsg = Math.max(...days.map((d) => d.messages), 1);
  for (const d of days) {
    const row = document.createElement("div");
    row.className = `day-row${state.timelineDay === d.date ? " selected" : ""}`;
    const pct = Math.round((d.messages / maxMsg) * 100);
    row.innerHTML = `<div><strong>${esc(d.date)}</strong></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="muted">セッション ${d.sessions} ・ 発言 ${d.messages}</div>`;
    row.title = (d.titles || []).join(" / ");
    row.addEventListener("click", async () => {
      state.timelineDay = state.timelineDay === d.date ? "" : d.date;
      state.offset = 0;
      await loadSessions();
      loadTimeline();
      if (state.timelineDay) switchTab("sessions");
    });
    el.appendChild(row);
  }
}
$("timelineClear").addEventListener("click", async () => {
  state.timelineDay = "";
  state.offset = 0;
  await loadSessions();
  loadTimeline();
});

// ---------- 統計 ----------
async function loadStats() {
  const s = await api("/api/stats");
  $("statsCards").innerHTML = `
    <div class="card"><div class="muted">セッション</div><div class="num">${s.sessionCount}</div></div>
    <div class="card"><div class="muted">メッセージ</div><div class="num">${s.messageCount}</div></div>
    <div class="card"><div class="muted">パーツ</div><div class="num">${s.partCount}</div></div>
    <div class="card"><div class="muted">合計コスト</div><div class="num">${Number(s.tokens.cost || 0).toFixed(2)}</div></div>
    <div class="card"><div class="muted">入力トークン</div><div class="num">${s.tokens.ti}</div></div>
    <div class="card"><div class="muted">出力トークン</div><div class="num">${s.tokens.tout}</div></div>`;
  $("statsProjects").innerHTML =
    `<table><tr><th>プロジェクト</th><th>セッション数</th><th>最終活動</th></tr>${s.perProject
      .map(
        (p) =>
          `<tr><td>${esc(p.worktree || p.id)}</td><td>${p.sessions}</td><td>${fmtTime(p.lastActive)}</td></tr>`,
      )
      .join("")}</table>`;
  $("statsTools").innerHTML =
    `<table><tr><th>ツール</th><th>回数</th></tr>${s.toolUsage
      .map((t) => `<tr><td>${esc(t.tool)}</td><td>${t.c}</td></tr>`)
      .join("")}</table>`;
}

// 初期化
await loadProjects();
await loadSessions();
moveTabIndicator();
window.addEventListener("resize", moveTabIndicator);
if (document.fonts?.ready) {
  document.fonts.ready.then(moveTabIndicator);
}
