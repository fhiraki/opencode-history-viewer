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

// ハイライト済み HTML のタグ部分を避けて検索語だけ <mark> 化する
export function markTermsHtml(html: string, terms: string[]): string {
  // 長大な検索語は正規表現の爆発を招くため切り詰める
  const clean = [
    ...new Set(terms.filter(Boolean).map((t) => t.slice(0, 100))),
  ].slice(0, 8);
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

function renderInlineCode(escapedHtml: string): string {
  return escapedHtml.replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>');
}

export function renderProse(text: string, terms: string[]): string {
  // 呼び出しごとに正規表現を生成する（モジュール共有の /g は lastIndex の競合を招く）
  const fenceRe = /```([^\n]*)\n([\s\S]*?)(?:\n```|```|$)/g;
  let html = "";
  let last = 0;
  let m = fenceRe.exec(text);
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
      html += `<div class="codeblock"><div class="codelang">${esc(label)}</div><pre><code class="hljs language-${esc(lang)}">${highlightTokens(code, lang)}</code></pre></div>`;
    }
    last = m.index + m[0].length;
    m = fenceRe.exec(text);
  }
  if (last < text.length) {
    html += renderInlineCode(esc(text.slice(last)));
  }
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
