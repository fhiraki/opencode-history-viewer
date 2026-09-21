import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import { esc } from "../shared/format.ts";

for (const [id, def] of Object.entries({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
})) {
  if (!hljs.getLanguage(id)) hljs.registerLanguage(id, def);
}

export const LANG_ALIASES: Record<string, string> = {
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
  md: "markdown",
  txt: "plaintext",
  text: "plaintext",
};

export const EXT_TO_LANG: Record<string, string> = {
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
  md: "markdown",
  mdx: "markdown",
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

// highlight.js の言語 ID への読み替え（html は xml として登録されている）
function hljsId(canonical: string): string {
  return canonical === "html" ? "xml" : canonical;
}

function isSupported(canonical: string): boolean {
  if (canonical === "plaintext") return true;
  return Boolean(hljs.getLanguage(hljsId(canonical)));
}

export function highlightTokens(raw: string, lang: string): string {
  // 巨大入力のハイライトは UI を固まらせるためプレーン表示に退避する
  if (raw.length > 20000) return esc(raw);
  if (lang === "plaintext" || !isSupported(lang)) return esc(raw);
  try {
    return hljs.highlight(raw, { language: hljsId(lang) }).value;
  } catch {
    // 不正な入力などで失敗したらプレーン表示にフォールバック
    return esc(raw);
  }
}

export function normalizeLang(info: string, code: string): string {
  if (info) {
    const alias = LANG_ALIASES[info];
    if (alias) return alias;
    if (isSupported(info)) return info;
    return "plaintext";
  }
  const trimmed = code.trim();
  // 巨大コードの自動判定はスキップする（JSON.parse / 行分割のコスト回避）
  if (trimmed.length > 50000) return "plaintext";
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// プレーンテキスト（エスケープ前）の検索語を <mark> 化する。
// 語ごとに逐次 replace すると、挿入した <mark> タグ自身に後続語（"mark" 等）が
// マッチして壊れるため、全語を1本の正規表現にまとめて1パスで置換する。
export function markPlainTextHtml(text: string, terms: string[]): string {
  const clean = normalizeTerms(terms);
  const out = esc(text);
  if (!clean.length) return out;
  const pattern = new RegExp(
    `(${clean.map((t) => escapeRegExp(esc(t))).join("|")})`,
    "gi",
  );
  return out.replace(pattern, "<mark>$1</mark>");
}

// 検索語の正規化（空白分割・空除去・重複除去・長大語切り詰め・最大8語）。
// スニペット強調・本文マーク・API クエリで共通利用する。
export function normalizeTerms(input: string | string[]): string[] {
  const raw = Array.isArray(input)
    ? input.flatMap((t) => t.split(/\s+/))
    : input.split(/\s+/);
  return [...new Set(raw.filter(Boolean).map((t) => t.slice(0, 100)))].slice(
    0,
    8,
  );
}

// ハイライト済み HTML のタグ部分を避けて検索語だけ <mark> 化する
export function markTermsHtml(html: string, terms: string[]): string {
  // 長大な検索語は正規表現の爆発を招くため切り詰める
  const clean = normalizeTerms(terms);
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

// ---------- Markdown 描画（marked + 自前の安全化） ----------
// パースは marked（GFM）に任せ、XSS 対策として (1) 生 HTML は esc して無効化、
// (2) リンク先は mdSanitizeUrl で危険スキームを拒否、
// (3) コードブロックは従来通り highlightTokens で描画する。
// marked の既定出力タグ（見出し・強調・リスト・引用・表など）は構造由来の
// 安全なものに限られる。画像は外部取得を避けてリンク表示にする。
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = normalizeLang((lang || "").trim().toLowerCase(), text);
      const label = language === "plaintext" ? "TEXT" : language.toUpperCase();
      return `<div class="codeblock"><div class="codelang">${esc(label)}</div><pre><code class="hljs language-${esc(language)}">${highlightTokens(text, language)}</code></pre></div>`;
    },
    codespan({ text }) {
      return `<code class="ic">${esc(text)}</code>`;
    },
    html({ text }) {
      return esc(text);
    },
    link({ href, tokens }) {
      const safe = mdSanitizeUrl(href);
      const label = this.parser.parseInline(tokens ?? []);
      return safe
        ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${label || esc(safe)}</a>`
        : label;
    },
    image({ href, tokens }) {
      const safe = mdSanitizeUrl(href);
      const label = this.parser.parseInline(tokens ?? []);
      return safe
        ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${label || esc(safe)}</a>`
        : label;
    },
  },
});

/** URL をリンク化してよいか判定する（生文字列を受け取り、埋め込み時に esc する） */
function mdSanitizeUrl(url: string): string | null {
  const u = url.trim();
  if (!u || /[\s<>]/.test(u)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  // 相対 URL は viewer 内の意図せぬ遷移になるためリンク化しない
  if (!scheme) return null;
  const s = scheme[1].toLowerCase();
  if (s !== "http" && s !== "https" && s !== "mailto") return null;
  return u;
}

export function renderProse(text: string, terms: string[]): string {
  let html: string;
  try {
    html = marked.parse(text, { breaks: true, gfm: true }) as string;
  } catch {
    html = esc(text);
  }
  // 横に長い表がレイアウトを壊さないよう、marked が生成した table を薄くラップする
  html = html
    .replaceAll("<table>", '<div class="md-table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  return markTermsHtml(html, terms);
}

export interface ToolPartLike {
  tool?: string;
  input?: string;
}

// read/edit/write の filePath から出力の言語を推定する（他ツールはプレーン表示）
export function toolOutputLang(p: ToolPartLike): string {
  if (p.tool !== "read" && p.tool !== "edit" && p.tool !== "write") {
    return "plaintext";
  }
  try {
    const input: unknown = JSON.parse(p.input || "{}");
    const filePath =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).filePath
        : "";
    const base =
      typeof filePath === "string" ? filePath.split(/[\\/]/).pop() || "" : "";
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    return (ext && EXT_TO_LANG[ext]) || "plaintext";
  } catch {
    return "plaintext";
  }
}
