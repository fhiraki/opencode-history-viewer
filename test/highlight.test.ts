import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  highlightTokens,
  markPlainTextHtml,
  markTermsHtml,
  normalizeLang,
  normalizeTerms,
  renderProse,
  toolOutputLang,
} from "../src/client/highlight.ts";

describe("normalizeLang", () => {
  it("resolves aliases and known languages", () => {
    assert.equal(normalizeLang("js", ""), "javascript");
    assert.equal(normalizeLang("py", ""), "python");
    assert.equal(normalizeLang("rust", ""), "rust");
  });
  it("falls back to plaintext for unknown tags", () => {
    assert.equal(normalizeLang("foobar", "hello"), "plaintext");
  });
  it("auto-detects JSON and diff", () => {
    assert.equal(normalizeLang("", '{"a": 1}'), "json");
    assert.equal(normalizeLang("", "+ added\n- removed"), "diff");
    assert.equal(normalizeLang("", "just text"), "plaintext");
  });
});

describe("highlightTokens", () => {
  it("emits hljs spans for known languages", () => {
    const html = highlightTokens("const x = 1;", "javascript");
    assert.match(html, /hljs-keyword/);
    assert.match(html, /hljs-number/);
  });
  it("escapes HTML and falls back for unknown languages", () => {
    assert.equal(highlightTokens("<b>", "plaintext"), "&lt;b&gt;");
    assert.equal(highlightTokens("<b>", "nope"), "&lt;b&gt;");
  });
  it("never throws on hostile input", () => {
    assert.doesNotThrow(() =>
      highlightTokens("`unterminated ${x", "javascript"),
    );
    assert.doesNotThrow(() => highlightTokens("a".repeat(20000), "python"));
  });
});

describe("markTermsHtml", () => {
  it("marks terms outside tags only", () => {
    const out = markTermsHtml('<span class="x">Agent Smith</span>', ["agent"]);
    assert.equal(out, '<span class="x"><mark>Agent</mark> Smith</span>');
  });
  it("returns input unchanged without terms", () => {
    assert.equal(markTermsHtml("<b>x</b>", []), "<b>x</b>");
  });
});

describe("markPlainTextHtml", () => {
  it("marks terms in escaped plain text", () => {
    assert.equal(
      markPlainTextHtml("a mark here", ["a", "mark"]),
      "<mark>a</mark> <mark>mark</mark> here",
    );
    assert.equal(
      markPlainTextHtml("<b>x</b>", ["x"]),
      "&lt;b&gt;<mark>x</mark>&lt;/b&gt;",
    );
  });
  it("does not rescan its own <mark> tags", () => {
    // 逐次 replace 実装だと term "mark" が挿入済みタグに再マッチして壊れる
    const out = markPlainTextHtml("a mark here", ["a", "mark"]);
    assert.equal(out.includes("<<"), false);
    assert.equal((out.match(/<mark>/g) ?? []).length, 2);
  });
  it("returns escaped text unchanged without terms", () => {
    assert.equal(markPlainTextHtml("<b>x</b>", []), "&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("renderProse", () => {
  it("renders fenced blocks with language labels", () => {
    const out = renderProse("```js\nconst x = 1;\n```", []);
    assert.match(out, /codelang">JAVASCRIPT/);
    assert.match(out, /hljs-keyword/);
  });
  it("renders inline code spans", () => {
    assert.equal(
      renderProse("use `fmtCount` here", []).includes('class="ic"'),
      true,
    );
  });
  it("marks search terms in prose", () => {
    const out = renderProse("hello world", ["world"]);
    assert.match(out, /<mark>world<\/mark>/);
  });
});

describe("renderProse markdown", () => {
  it("renders headings and paragraphs", () => {
    assert.equal(renderProse("## Title", []).includes("<h2>Title</h2>"), true);
    assert.equal(renderProse("a\nb", []).includes("<p>a<br>b</p>"), true);
  });
  it("leaves hash-tags without space as text", () => {
    assert.equal(renderProse("#tag", []).includes("<p>#tag</p>"), true);
  });
  it("renders bold, italic and strikethrough", () => {
    const out = renderProse("**b** *i* ~~s~~", []);
    assert.match(out, /<strong>b<\/strong>/);
    assert.match(out, /<em>i<\/em>/);
    assert.match(out, /<del>s<\/del>/);
  });
  it("does not emphasize inside words with underscores", () => {
    assert.equal(renderProse("foo_bar_baz", []).includes("<em>"), false);
  });
  it("renders links and blocks unsafe schemes", () => {
    const safe = renderProse("[text](https://example.com)", []);
    assert.match(
      safe,
      /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">text<\/a>/,
    );
    const evil = renderProse("[x](javascript:alert(1))", []);
    assert.equal(evil.includes("<a"), false);
    assert.match(evil, /<p>x<\/p>/);
  });
  it("renders images as links without fetching", () => {
    const out = renderProse("![alt](https://example.com/i.png)", []);
    assert.equal(out.includes("<img"), false);
    assert.match(out, /<a href="https:\/\/example\.com\/i\.png"/);
  });
  it("renders unordered, ordered and task lists", () => {
    const ul = renderProse("- a\n- b", []);
    assert.match(ul, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
    const ol = renderProse("1. a\n2. b", []);
    assert.match(ol, /<ol>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ol>/);
    const task = renderProse("- [ ] t\n- [x] d", []);
    assert.match(task, /<input disabled="" type="checkbox">/);
    assert.match(task, /<input checked="" disabled="" type="checkbox">/);
  });
  it("renders blockquotes, rules and tables", () => {
    assert.equal(renderProse("> quoted", []).includes("<blockquote>"), true);
    assert.equal(renderProse("a\n\n---\n\nb", []).includes("<hr>"), true);
    const table = renderProse("| a | b |\n| --- | ---: |\n| 1 | 2 |", []);
    assert.match(table, /<table>/);
    assert.match(table, /<th>a<\/th>/);
    assert.match(table, /align="right"/);
  });
  it("wraps tables for horizontal scrolling", () => {
    const table = renderProse("| a | b |\n| --- | --- |\n| 1 | 2 |", []);
    assert.match(table, /<div class="md-table-wrap"><table>/);
    assert.match(table, /<\/table><\/div>/);
  });
  it("escapes raw HTML to prevent XSS", () => {
    const out = renderProse("<script>alert(1)</script>", []);
    assert.equal(out.includes("<script>"), false);
    assert.match(out, /&lt;script&gt;/);
  });
  it("keeps markdown markers inside code spans literal", () => {
    const out = renderProse("`**not bold**`", []);
    assert.match(out, /<code class="ic">\*\*not bold\*\*<\/code>/);
  });
});

describe("toolOutputLang", () => {
  it("detects language from filePath for file tools", () => {
    assert.equal(
      toolOutputLang({
        tool: "read",
        input: '{"filePath":"/a/b/calc.py"}',
      }),
      "python",
    );
    assert.equal(
      toolOutputLang({ tool: "edit", input: '{"filePath":"/a/b.ts"}' }),
      "typescript",
    );
  });
  it("returns plaintext for other tools and bad input", () => {
    assert.equal(toolOutputLang({ tool: "bash", input: "{}" }), "plaintext");
    assert.equal(toolOutputLang({ tool: "read", input: "!!!" }), "plaintext");
    assert.equal(toolOutputLang({}), "plaintext");
  });
});

describe("normalizeTerms", () => {
  it("splits, dedups, truncates and caps terms", () => {
    assert.deepEqual(normalizeTerms("  foo  bar foo "), ["foo", "bar"]);
    assert.deepEqual(normalizeTerms(["a b", "b c"]), ["a", "b", "c"]);
    assert.deepEqual(normalizeTerms(""), []);
    assert.equal(normalizeTerms("x".repeat(150))[0]?.length, 100);
    assert.equal(normalizeTerms("0 1 2 3 4 5 6 7 8 9").length, 8);
  });
});

describe("renderProse links", () => {
  it("renders relative URLs as plain text without links", () => {
    assert.equal(renderProse("[rel](./other.md)", []).includes("<a"), false);
    assert.equal(renderProse("[frag](#sec)", []).includes("<a"), false);
  });
});
