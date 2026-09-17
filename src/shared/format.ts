export interface ModelInfo {
  provider: string;
  id: string;
  variant: string;
}

export function fmtTime(ms: number): string {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  return d.toLocaleString("en-US", { hourCycle: "h23" });
}

// セッションの model（JSON文字列またはプレーン文字列）を {provider, id, variant} に正規化
export function parseModel(model: unknown): ModelInfo | null {
  if (!model) return null;
  try {
    const o: unknown = typeof model === "string" ? JSON.parse(model) : model;
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      return {
        provider: typeof r.providerID === "string" ? r.providerID : "",
        id:
          typeof r.id === "string"
            ? r.id
            : typeof r.modelID === "string"
              ? r.modelID
              : "",
        variant: typeof r.variant === "string" ? r.variant : "",
      };
    }
  } catch {
    // JSON ではないのでプレーン文字列として扱う
  }
  return { provider: "", id: String(model), variant: "" };
}

// Display text for a session model, e.g. "opencode-go/muse-spark · xhigh"
export function modelText(model: unknown): string {
  const m = parseModel(model);
  if (!m?.id) return "";
  return `${m.provider ? `${m.provider}/` : ""}${m.id}${
    m.variant && m.variant !== "default" ? ` · ${m.variant}` : ""
  }`;
}

export function fmtCost(c: number): string {
  const v = Number(c || 0);
  if (v <= 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtCount(n: number): string {
  let v = Number(n || 0);
  const units = ["", "k", "M", "B", "T"];
  let u = 0;
  while (u < units.length - 1 && v >= 999.95) {
    v /= 1000;
    u += 1;
  }
  const r = u === 0 ? Math.floor(v) : Math.round(v * 10) / 10;
  return `${r}${units[u]}`;
}

// カンマ区切りの正確値（コンパクト表示の title 属性用）
export function fmtExact(n: number): string {
  return Number(n || 0).toLocaleString("en-US");
}

export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(Number(ms || 0) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) {
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// 同日なら「9/18 0:13 → 1:08」、跨ぎなら両日＋所要時間を付ける
export function fmtRange(from: number, to: number): string {
  const a = new Date(Number(from));
  const b = new Date(Number(to));
  const d = (x: Date): string => `${x.getMonth() + 1}/${x.getDate()}`;
  const t = (x: Date): string =>
    `${x.getHours()}:${String(x.getMinutes()).padStart(2, "0")}`;
  const range =
    a.toDateString() === b.toDateString()
      ? `${d(a)} ${t(a)} → ${t(b)}`
      : `${d(a)} ${t(a)} → ${d(b)} ${t(b)}`;
  return `${range} (${fmtDuration(b.getTime() - a.getTime())})`;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ホームディレクトリ以下を ~/ 表記に短縮する（一致しなければそのまま）
export function shortenHome(dir: string, home: string): string {
  if (!dir || !home) return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}
