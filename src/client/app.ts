import "highlight.js/styles/github-dark.css";
import {
  esc,
  fmtCost,
  fmtCount,
  fmtDayWithWeekday,
  fmtDuration,
  fmtExact,
  fmtRange,
  fmtTime,
  modelText,
  prettyJson,
  shortenHome,
} from "../shared/format.ts";
import { resolveNavIndex } from "../shared/nav.ts";
import {
  highlightTokens,
  markTermsHtml,
  normalizeTerms,
  renderProse,
  toolOutputLang,
} from "./highlight.ts";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};
function $input(id: string): HTMLInputElement {
  const el = $(id);
  if (!(el instanceof HTMLInputElement))
    throw new Error(`#${id} is not an input`);
  return el;
}

const state = {
  tab: "sessions",
  sessions: [] as SessionItem[],
  total: 0,
  limit: 50,
  offset: 0,
  q: "",
  project: "",
  sort: "updated",
  selectedId: null as string | null,
  searchQ: "",
  searchOffset: 0,
  searchTotal: 0,
  timelineDay: "",
  highlight: "",
  home: "",
};

function $select(id: string): HTMLSelectElement {
  const el = $(id);
  if (!(el instanceof HTMLSelectElement))
    throw new Error(`#${id} is not a select`);
  return el;
}
function $button(id: string): HTMLButtonElement {
  const el = $(id);
  if (!(el instanceof HTMLButtonElement))
    throw new Error(`#${id} is not a button`);
  return el;
}
function highlightHtml(text: string, terms: string[]): string {
  let out = esc(text);
  for (const raw of normalizeTerms(terms)) {
    // 長大な検索語は正規表現の爆発を招くため切り詰める（normalizeTerms 済み）
    const e = esc(raw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      out = out.replace(new RegExp(`(${e})`, "gi"), "<mark>$1</mark>");
    } catch {}
  }
  return out;
}
function searchTerms() {
  return normalizeTerms(state.highlight);
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) {
    // サーバー側の { error } を診断用に付加する（巨大ボディ対策で先頭200字まで）
    let detail = "";
    try {
      const text = (await r.text()).slice(0, 200);
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string" && body.error) detail = body.error;
        else if (text) detail = text;
      } catch {
        if (text) detail = text;
      }
    } catch {}
    throw new Error(`${path}: ${r.status}${detail ? ` ${detail}` : ""}`);
  }
  return (await r.json()) as T;
}

interface ProjectItem {
  id: string;
  worktree: string;
  sessionCount: number;
}
interface SessionItem {
  id: string;
  project_id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  messageCount: number;
  preview?: string;
  agent?: string;
  model?: unknown;
}
interface ApiPart {
  id: string;
  type: string;
  time_created: number;
  text?: string;
  truncated?: boolean;
  fullLength?: number;
  tool?: string;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  outputTruncated?: boolean;
  outputFullLength?: number;
  files?: string[];
  rawText?: string;
}
interface ApiMessage {
  id: string;
  role: string;
  time_created: number;
  tokens?: { total?: number } | null;
  parts: ApiPart[];
}
interface SessionDetail {
  session: SessionItem;
  messages: ApiMessage[];
}
interface SearchHit {
  session_id: string;
  session_title: string;
  directory: string;
  part_type: string;
  tool?: string | null;
  time_created: number;
  snippet: string;
}
interface TimelineDay {
  date: string;
  sessions: number;
  messages: number;
  cost: number;
  titles: string[];
}
interface PerProjectRow {
  id: string;
  worktree: string;
  sessions: number;
  lastActive: number;
}
interface PerModelRow {
  provider: string | null;
  id: string | null;
  sessions: number;
  messages: number;
  activeMs: number;
  cost: number;
  ti: number;
  tout: number;
  tr: number;
}
interface ToolUsageRow {
  tool: string;
  c: number;
}

// ---------- タブ ----------
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab ?? ""));
});
function switchTab(name: string): void {
  state.tab = name;
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
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
function moveTabIndicator(): void {
  const nav = document.querySelector<HTMLElement>(".tabs");
  const active = nav?.querySelector<HTMLButtonElement>("button.active");
  const indicator = nav?.querySelector<HTMLElement>(".tabs-indicator");
  if (!nav || !active || !indicator) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

// ---------- プロジェクト ----------
async function loadProjects() {
  const { projects } = await api<{ projects: ProjectItem[] }>("/api/projects");
  const sel = $("projectFilter");
  sel.innerHTML = `<option value="">All projects</option>`;
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.id;
    const label = p.worktree || p.id;
    o.textContent = `${label} (${p.sessionCount})`;
    sel.appendChild(o);
  }
}

// ---------- セッション一覧 ----------
// 非同期の競合対策: 連打・入力中の古いレスポンスが新しい表示を上書きしないよう世代管理する
let sessionSeq = 0;
let detailSeq = 0;
let searchSeq = 0;
async function loadSessions() {
  const my = ++sessionSeq;
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
  const data = await api<{
    sessions: SessionItem[];
    total: number;
    home?: string;
  }>(`/api/sessions?${params}`);
  if (my !== sessionSeq) return;
  state.sessions = data.sessions;
  state.total = data.total;
  if (data.home) state.home = data.home;
  renderSessionList();
}

function renderSessionList() {
  const el = $("sessionList");
  el.innerHTML = "";
  $("sessionCount").textContent =
    `${fmtCount(state.total)} sessions${state.timelineDay ? ` (${fmtDayWithWeekday(state.timelineDay)})` : ""}`;
  $("pageInfo").textContent =
    state.total === 0
      ? `0 / 0`
      : `${fmtCount(state.offset + 1)}–${fmtCount(Math.min(state.offset + state.limit, state.total))} / ${fmtCount(state.total)}`;
  $button("prevPage").disabled = state.offset <= 0;
  $button("nextPage").disabled = state.offset + state.limit >= state.total;
  for (const s of state.sessions) {
    const b = document.createElement("button");
    b.className = `session-item${s.id === state.selectedId ? " selected" : ""}`;
    b.innerHTML = `
      <span class="msg-badge" title="${fmtExact(s.messageCount)} messages"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v6.5H8.2L5 12.5v-2.5H2.5z" /></svg>${fmtCount(s.messageCount)}</span>
      <div class="title">${esc(s.title || "(Untitled)")}</div>
      <div class="meta">${esc(shortenHome(s.directory || "", state.home))} · ${fmtTime(s.time_updated)}</div>
      ${s.preview ? `<div class="preview">${esc(s.preview.slice(0, 160))}</div>` : ""}`;
    b.addEventListener("click", () => selectSession(s.id));
    el.appendChild(b);
  }
  if (!state.sessions.length)
    el.innerHTML = `<p class="muted">No sessions found.</p>`;
}

async function selectSession(id: string, highlight = ""): Promise<void> {
  state.selectedId = id;
  state.highlight = highlight;
  renderSessionList();
  const my = ++detailSeq;
  const el = $("sessionDetail");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const data = await api<SessionDetail>(
      `/api/session/${encodeURIComponent(id)}`,
    );
    if (my !== detailSeq) return;
    el.innerHTML = renderDetail(data, searchTerms());
    el.scrollTop = 0;
  } catch (e) {
    if (my !== detailSeq) return;
    el.innerHTML = `<p>Failed to load: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
  buildNav();
}

function renderDetail(
  { session, messages }: SessionDetail,
  terms: string[],
): string {
  const text = modelText(session.model);
  const cost = Number(session.cost || 0);
  const tokIn = Number(session.tokens_input || 0);
  const tokOut = Number(session.tokens_output || 0);
  const tokReason = Number(session.tokens_reasoning || 0);
  const chips = [
    text
      ? `<span class="chip model" title="${esc(session.model || "")}"><span class="chip-label">Model</span>${esc(text)}</span>`
      : "",
    session.agent
      ? `<span class="chip"><span class="chip-label">Agent</span>${esc(session.agent)}</span>`
      : "",
    `<span class="chip cost" title="Exact: $${cost}"><span class="chip-label">Cost</span>${esc(fmtCost(cost))}</span>`,
    `<span class="chip" title="Input ${tokIn.toLocaleString("en-US")} / Output ${tokOut.toLocaleString("en-US")} / Reasoning ${tokReason.toLocaleString("en-US")}"><span class="chip-label">Tokens</span>${esc(fmtCount(tokIn + tokOut + tokReason))}</span>`,
    `<span class="chip"><span class="chip-label">Messages</span>${fmtCount(messages.length)}</span>`,
  ].join("");
  const head = `
    <h2>${esc(session.title || "(Untitled)")}</h2>
    <div class="chips">${chips}</div>
    <div class="muted sub-line">${esc(shortenHome(session.directory || "", state.home))} · ${esc(fmtRange(session.time_created, session.time_updated))}</div>`;
  const body = renderTurns(messages, terms);
  return head + body;
}

// ---------- ターン区切り＋回答抽出（Phase 1） ----------
// 1往復（User発言→次のUser発言まで）を .turn で囲み、左ボーダーで区切る。
// assistantメッセージ内では text を「回答カード」として先頭に抜き出し、
// tool/reasoning/patch 等は1つの「作業ログ」detailsにまとめる（回答が埋もれない）。
// 作業ログは閉状態で描画し、巨大セッションの描画コストを増やさない。
function groupIntoTurns(messages: ApiMessage[]): ApiMessage[][] {
  const turns: ApiMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return turns.filter((t) => t.length > 0);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function worklogSummaryText(workParts: ApiPart[]): string {
  const names: string[] = [];
  for (const p of workParts) {
    if (p.type === "tool") names.push(String(p.tool || "tool"));
    else if (p.type === "reasoning") names.push("reasoning");
    else names.push(String(p.type || "part"));
  }
  const uniq = [...new Set(names)].slice(0, 5);
  const tools = uniq.length ? ` — ${uniq.join(", ")}` : "";
  return `Working log · ${plural(workParts.length, "step")}${tools}`;
}

function renderTurns(messages: ApiMessage[], terms: string[]): string {
  const turns = groupIntoTurns(messages);
  let turnNo = 0;
  return turns
    .map((turn) => {
      const isOpening = turn[0]?.role !== "user";
      if (!isOpening) turnNo += 1;
      const html = turn
        .map((m) => renderMessage(m, terms))
        .filter(Boolean)
        .join("");
      if (!html) return "";
      const userCount = turn.filter((m) => m.role === "user").length;
      let answers = 0;
      let steps = 0;
      for (const m of turn) {
        if (m.role !== "assistant") continue;
        for (const p of m.parts) {
          if (p.type === "text") {
            if ((p.text || "").trim()) answers += 1;
          } else if (p.type !== "step-start" && p.type !== "step-finish") {
            steps += 1;
          }
        }
      }
      const meta: string[] = [];
      if (userCount > 0) meta.push(plural(userCount, "question"));
      if (answers > 0) meta.push(plural(answers, "answer"));
      if (steps > 0) meta.push(plural(steps, "step"));
      return `<section class="turn${isOpening ? " opening" : ""}">
      <div class="turn-head"><span class="turn-label">${isOpening ? "Opening" : `Turn ${turnNo}`}</span>
      ${meta.length ? `<span class="turn-meta">${esc(meta.join(" · "))}</span>` : ""}</div>
      ${html}</section>`;
    })
    .join("");
}

function msgHeadInner(m: ApiMessage): string {
  return `<span class="role ${esc(m.role)}">${esc(m.role)}</span>
      <span class="time">${fmtTime(m.time_created)}</span>
      ${m.tokens ? `<span class="time">tok ${m.tokens.total == null ? "" : Number(m.tokens.total).toLocaleString("en-US")}</span>` : ""}`;
}

function renderMessage(m: ApiMessage, terms: string[]): string {
  const head = `<div class="msg-head">${msgHeadInner(m)}</div>`;
  if (m.role === "assistant") {
    const answerHtml = m.parts
      .filter((p) => p.type === "text" && (p.text || "").trim())
      .map((p) => renderAnswerPart(p, terms))
      .filter(Boolean)
      .join("");
    const workParts = m.parts.filter((p) => {
      if (
        p.type === "text" ||
        p.type === "step-start" ||
        p.type === "step-finish"
      )
        return false;
      if (p.type === "reasoning" && !(p.text || "").trim()) return false;
      return true;
    });
    const workHtml = workParts
      .map((p) => renderWorkPart(p, terms))
      .filter(Boolean)
      .join("");
    if (!answerHtml && !workHtml) return "";
    // 回答なし（作業のみ）のメッセージは行数を食うため、
    // msg-headと作業ログ概要を1行に合体させ、その行自体を開閉スイッチにする
    if (!answerHtml) {
      return `<details class="msg assistant-msg work-only"><summary class="msg-head">${msgHeadInner(m)}
      <span class="work-summary">${esc(worklogSummaryText(workParts))}</span></summary><div class="worklog-body">${workHtml}</div></details>`;
    }
    const worklog = workHtml
      ? `<details class="part worklog"><summary>${esc(worklogSummaryText(workParts))}</summary><div class="worklog-body">${workHtml}</div></details>`
      : "";
    return `<div class="msg assistant-msg">${head}${answerHtml}${worklog}</div>`;
  }
  if (m.role === "user") {
    const parts = m.parts
      .map((p) => renderPart(p, terms, m.role))
      .filter(Boolean)
      .join("");
    if (!parts) return "";
    return `<div class="msg user-msg">${head}${parts}</div>`;
  }
  if (m.role !== "assistant") {
    const parts = m.parts
      .map((p) => renderPart(p, terms, m.role))
      .filter(Boolean)
      .join("");
    if (!parts) return "";
    return `<div class="msg">${head}${parts}</div>`;
  }
  return "";
}

function renderAnswerPart(p: ApiPart, terms: string[]): string {
  return `<div class="part answer"><div class="part-head answer-head">Answer</div><div class="part-body prose">${renderProse(p.text || "", terms)}${p.truncated ? `<div class="muted">… (${Number(p.fullLength || 0).toLocaleString("en-US")} chars total, truncated)</div>` : ""}</div></div>`;
}

function renderPart(p: ApiPart, terms: string[], role = "unknown"): string {
  if (p.type === "step-start" || p.type === "step-finish") return "";
  if (p.type === "text" || p.type === "reasoning") {
    if (p.type === "reasoning") {
      return renderWorkPart(p, terms);
    }
    if (role === "assistant") return renderAnswerPart(p, terms);
    if (!(p.text || "").trim() && !p.truncated) return "";
    return `<div class="part question"><div class="part-body prose">${renderProse(p.text || "", terms)}${p.truncated ? `<div class="muted">… (${Number(p.fullLength || 0).toLocaleString("en-US")} chars total, truncated)</div>` : ""}</div></div>`;
  }
  return renderWorkPart(p, terms);
}

function renderWorkPart(p: ApiPart, terms: string[]): string {
  if (p.type === "reasoning") {
    if (!(p.text || "").trim()) return "";
    return `<details class="part work-item"><summary>Reasoning (click to expand)</summary><div class="part-body prose">${renderProse(p.text || "", terms)}</div></details>`;
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
    // 巨大セッション対策: ツール詳細は閉じた状態で描画し、レイアウト・ペイントを遅延させる
    return `<details class="part work-item"><summary>🔧 ${label}</summary>
      <div class="part-head">Input</div><div class="part-body">${inputHtml}</div>
      <div class="part-head">Output${p.outputTruncated ? ` (showing part of ${Number(p.outputFullLength || 0).toLocaleString("en-US")} chars)` : ""}</div><div class="part-body">${outputHtml}</div>
    </details>`;
  }
  if (p.type === "patch") {
    return `<div class="part work-item"><div class="part-head">patch</div><div class="part-body">${esc((p.files || []).join("\n"))}</div></div>`;
  }
  if (p.type === "compaction")
    return `<div class="part work-item"><div class="part-head">compaction</div></div>`;
  return `<div class="part work-item"><div class="part-head">${esc(p.type)}</div><div class="part-body">${esc(p.rawText || "")}</div></div>`;
}

$("prevPage").addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadSessions();
});
$("nextPage").addEventListener("click", () => {
  if (state.offset + state.limit < state.total) state.offset += state.limit;
  loadSessions();
});
$("projectFilter").addEventListener("change", () => {
  state.project = $select("projectFilter").value;
  state.offset = 0;
  loadSessions();
});
$("sortSelect").addEventListener("change", () => {
  state.sort = $select("sortSelect").value;
  state.offset = 0;
  loadSessions();
});
let sessionFilterTimer: ReturnType<typeof setTimeout> | undefined;
$("sessionFilter").addEventListener("input", () => {
  clearTimeout(sessionFilterTimer);
  sessionFilterTimer = setTimeout(() => {
    state.q = $input("sessionFilter").value.trim();
    state.offset = 0;
    loadSessions();
  }, 300);
});
// DB からの手動リロード（引っ張り更新の代わり）。ページ全体はリロードしない
$("reloadBtn").addEventListener("click", async () => {
  const btn = $button("reloadBtn");
  btn.disabled = true;
  try {
    await loadProjects();
    // loadProjects が option を作り直すため、選択中のプロジェクトを復元する
    const sel = $select("projectFilter");
    sel.value = state.project;
    if (sel.value !== state.project) state.project = "";
    state.offset = 0;
    await loadSessions();
  } finally {
    btn.disabled = false;
  }
});

// ---------- 全文検索 ----------
async function runSearch() {
  const q = $input("searchInput").value.trim();
  state.searchQ = q;
  state.searchOffset = 0;
  await loadSearch();
}
async function loadSearch() {
  const my = ++searchSeq;
  const box = $("searchResults");
  if (!state.searchQ) {
    box.innerHTML = `<p class="muted">Enter keywords to search.</p>`;
    $("searchCount").textContent = "";
    $("searchPageInfo").textContent = "";
    $button("searchPrev").disabled = true;
    $button("searchNext").disabled = true;
    return;
  }
  box.innerHTML = `<p class="muted">Searching…</p>`;
  const params = new URLSearchParams({
    q: state.searchQ,
    limit: "50",
    offset: String(state.searchOffset),
    project: state.project,
  });
  let data: { hits: SearchHit[]; total: number; home?: string };
  try {
    data = await api<{ hits: SearchHit[]; total: number; home?: string }>(
      `/api/search?${params}`,
    );
  } catch (e) {
    if (my !== searchSeq) return;
    box.innerHTML = `<p>Search failed: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
    $("searchCount").textContent = "";
    $("searchPageInfo").textContent = "";
    $button("searchPrev").disabled = true;
    $button("searchNext").disabled = true;
    return;
  }
  if (my !== searchSeq) return;
  state.searchTotal = data.total;
  if (data.home) state.home = data.home;
  $("searchCount").textContent = `${fmtCount(data.total)} results`;
  $("searchPageInfo").textContent =
    data.total === 0
      ? `0 / 0`
      : `${fmtCount(state.searchOffset + 1)}–${fmtCount(Math.min(state.searchOffset + 50, data.total))} / ${fmtCount(data.total)}`;
  $button("searchPrev").disabled = state.searchOffset <= 0;
  $button("searchNext").disabled = state.searchOffset + 50 >= data.total;
  box.innerHTML = "";
  const terms = normalizeTerms(state.searchQ);
  for (const h of data.hits) {
    const d = document.createElement("div");
    d.className = "hit";
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.innerHTML = `
      <div><strong>${esc(h.session_title || "(Untitled)")}</strong>
      <span class="muted">[${esc(h.part_type)}${h.tool ? `:${esc(h.tool)}` : ""}] ${fmtTime(h.time_created)}</span></div>
      <div class="muted">${esc(shortenHome(h.directory || "", state.home))}</div>
      <div class="snippet">${highlightHtml(h.snippet || "", terms)}</div>`;
    const openHit = async () => {
      switchTab("sessions");
      await selectSession(h.session_id, state.searchQ);
    };
    d.addEventListener("click", openHit);
    d.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openHit();
      }
    });
    box.appendChild(d);
  }
  if (!data.hits.length)
    box.innerHTML = `<p class="muted">No results found.</p>`;
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
  el.innerHTML = `<p class="muted">Loading…</p>`;
  const params = new URLSearchParams({ project: state.project });
  let days: TimelineDay[];
  try {
    ({ days } = await api<{ days: TimelineDay[] }>(`/api/timeline?${params}`));
  } catch (e) {
    el.innerHTML = `<p>Failed to load timeline: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
    return;
  }
  el.innerHTML = "";
  if (!days.length) {
    el.innerHTML = `<p class="muted">No data.</p>`;
    return;
  }
  const maxMsg = Math.max(...days.map((d) => d.messages), 1);
  for (const d of days) {
    const row = document.createElement("div");
    row.className = `day-row${state.timelineDay === d.date ? " selected" : ""}`;
    const pct = Math.round((d.messages / maxMsg) * 100);
    row.innerHTML = `<div><strong>${esc(fmtDayWithWeekday(d.date))}</strong></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="muted">${fmtCount(d.sessions)} sessions · ${fmtCount(d.messages)} messages · ${esc(fmtCost(d.cost || 0))}</div>`;
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

// ---------- やり取りナビ（User発言 ⇄ AI最終回答の往復移動） ----------
let navAnchors: HTMLElement[] = [];
let navPos = 0;

function buildNav(): void {
  navAnchors = [];
  navPos = 0;
  const msgs = [...$("sessionDetail").querySelectorAll(".msg")];
  const isUser = (m: Element): boolean =>
    m.querySelector(".role")?.classList.contains("user") ?? false;
  let i = msgs.findIndex(isUser);
  while (i >= 0 && i < msgs.length) {
    navAnchors.push(msgs[i] as HTMLElement);
    let j = i + 1;
    while (j < msgs.length && !isUser(msgs[j])) j += 1;
    if (j - 1 > i) navAnchors.push(msgs[j - 1] as HTMLElement);
    i = j;
  }
  updateNav();
}

function updateNav(): void {
  $button("navUp").disabled = navAnchors.length === 0 || navPos <= 0;
  $button("navDown").disabled =
    navAnchors.length === 0 || navPos >= navAnchors.length - 1;
  $("navPos").textContent = navAnchors.length
    ? `${navPos + 1} / ${navAnchors.length}`
    : "";
}

function moveNav(dir: 1 | -1): void {
  if (!navAnchors.length) return;
  navPos = Math.min(navAnchors.length - 1, Math.max(0, navPos + dir));
  const container = $("sessionDetail");
  const el = navAnchors[navPos];
  const top =
    el.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    12;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  container.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  updateNav();
}
$("navUp").addEventListener("click", () => moveNav(-1));
$("navDown").addEventListener("click", () => moveNav(1));

// 手動スクロールにカウンターを追従させる（スクロールスパイ）。
// moveNav の着地点（上端 -12px）より少し余裕を持たせ、上端付近の往復でちらつかないよう 80px とする
const NAV_SYNC_OFFSET = 80;
let navSyncQueued = false;
function syncNavFromScroll(): void {
  if (navAnchors.length === 0) return;
  const container = $("sessionDetail");
  const containerTop = container.getBoundingClientRect().top;
  const tops = navAnchors.map(
    (el) => el.getBoundingClientRect().top - containerTop,
  );
  const idx = resolveNavIndex(tops, NAV_SYNC_OFFSET);
  if (idx !== navPos) {
    navPos = idx;
    updateNav();
  }
}
function requestNavSync(): void {
  if (navSyncQueued) return;
  navSyncQueued = true;
  requestAnimationFrame(() => {
    navSyncQueued = false;
    syncNavFromScroll();
  });
}
$("sessionDetail").addEventListener("scroll", requestNavSync, {
  passive: true,
});
// <details> の開閉でアンカー位置がずれるため、レイアウト確定後に再同期する
$("sessionDetail").addEventListener("toggle", requestNavSync, true);
window.addEventListener("resize", requestNavSync);

// ---------- 統計 ----------
async function loadStats(): Promise<void> {
  let s: {
    sessionCount: number;
    messageCount: number;
    partCount: number;
    tokens: { cost: number; ti: number; tout: number };
    perProject: PerProjectRow[];
    perModel: PerModelRow[];
    toolUsage: ToolUsageRow[];
  };
  try {
    s = await api<{
      sessionCount: number;
      messageCount: number;
      partCount: number;
      tokens: { cost: number; ti: number; tout: number };
      perProject: PerProjectRow[];
      perModel: PerModelRow[];
      toolUsage: ToolUsageRow[];
    }>(`/api/stats`);
  } catch (e) {
    $("statsCards").innerHTML =
      `<p>Failed to load stats: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
    return;
  }
  $("statsCards").innerHTML = `
    <div class="card" title="${fmtExact(s.sessionCount)}"><div class="muted">Sessions</div><div class="num">${fmtCount(s.sessionCount)}</div></div>
    <div class="card" title="${fmtExact(s.messageCount)}"><div class="muted">Messages</div><div class="num">${fmtCount(s.messageCount)}</div></div>
    <div class="card" title="${fmtExact(s.partCount)}"><div class="muted">Parts</div><div class="num">${fmtCount(s.partCount)}</div></div>
    <div class="card" title="${esc(fmtCost(s.tokens.cost || 0))}"><div class="muted">Total cost</div><div class="num">${esc(fmtCost(s.tokens.cost || 0))}</div></div>
    <div class="card" title="${fmtExact(s.tokens.ti)}"><div class="muted">Input tokens</div><div class="num">${fmtCount(s.tokens.ti)}</div></div>
    <div class="card" title="${fmtExact(s.tokens.tout)}"><div class="muted">Output tokens</div><div class="num">${fmtCount(s.tokens.tout)}</div></div>`;
  $("statsProjects").innerHTML =
    `<table><tr><th>Project</th><th>Sessions</th><th>Last active</th></tr>${s.perProject
      .map(
        (p) =>
          `<tr><td>${esc(p.worktree || p.id)}</td><td>${fmtCount(p.sessions)}</td><td>${fmtTime(p.lastActive)}</td></tr>`,
      )
      .join("")}</table>`;
  $("statsModels").innerHTML =
    `<table><tr><th>Model</th><th>Sessions</th><th>Messages</th><th>Active time</th><th>Cost</th><th>Tokens</th></tr>${(
      s.perModel || []
    )
      .map((r) => {
        const name = r.id
          ? `${r.provider ? `${r.provider}/` : ""}${r.id}`
          : "(Unknown)";
        return `<tr><td title="${esc(name)}">${esc(name)}</td><td>${fmtCount(r.sessions)}</td><td>${fmtCount(r.messages)}</td><td>${esc(fmtDuration(r.activeMs))}</td><td>${esc(fmtCost(r.cost))}</td><td title="${fmtExact(r.ti + r.tout + r.tr)}">${fmtCount(r.ti + r.tout + r.tr)}</td></tr>`;
      })
      .join("")}</table>`;
  $("statsTools").innerHTML =
    `<table><tr><th>Tool</th><th>Count</th></tr>${s.toolUsage
      .map(
        (t) =>
          `<tr><td>${esc(t.tool)}</td><td title="${fmtExact(t.c)}">${fmtCount(t.c)}</td></tr>`,
      )
      .join("")}</table>`;
}

// 初期化（サーバー不在でも真っ白にせず理由を表示する）
try {
  await loadProjects();
  await loadSessions();
} catch (e) {
  const msg = `<p>Failed to connect to the server: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  $("sessionList").innerHTML = msg;
  $("sessionDetail").innerHTML = msg;
}
moveTabIndicator();
window.addEventListener("resize", moveTabIndicator);
if (document.fonts?.ready) {
  document.fonts.ready.then(moveTabIndicator);
}
