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
  if (name === "timeline") loadTimeline();
  if (name === "stats") loadStats();
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
  const head = `
    <h2>${esc(session.title || "(無題)")}</h2>
    <div class="muted">${esc(session.directory || "")} ・ ${esc(session.id)}<br>
    作成: ${fmtTime(session.time_created)} ／ 更新: ${fmtTime(session.time_updated)}<br>
    モデル: ${esc(session.model || "")} ・ エージェント: ${esc(session.agent || "")} ・ コスト: ${esc(session.cost ?? 0)}</div>`;
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
      return `<details class="part"><summary>推論過程（クリックで展開）</summary><div class="part-body">${highlightHtml(p.text || "", terms)}</div></details>`;
    }
    return `<div class="part"><div class="part-body prose">${highlightHtml(p.text || "", terms)}${p.truncated ? `<div class="muted">…（${p.fullLength} 文字のため省略）</div>` : ""}</div></div>`;
  }
  if (p.type === "tool") {
    const label =
      `${esc(p.tool)} ${esc(p.title || "")} ${esc(p.status || "")}`.trim();
    return `<details class="part" open><summary>🔧 ${label}</summary>
      <div class="part-head">入力</div><div class="part-body">${highlightHtml(p.input || "", terms)}</div>
      <div class="part-head">出力${p.outputTruncated ? `（${p.outputFullLength} 文字中一部）` : ""}</div><div class="part-body">${highlightHtml((p.output || "").slice(0, 8000), terms)}</div>
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
