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
import { esc } from "../src/shared/format.ts";

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
  it("skips auto-detection once the code exceeds 50000 chars", () => {
    // auto 判定のガードは trimmed.length > 50000（highlight.ts）。
    // ちょうど 50000 までは JSON として判定し、1 字超過で plaintext に戻る
    const jsonOf = (n: number): string => JSON.stringify({ b: "x".repeat(n) });
    assert.equal(jsonOf(49_992).length, 50_000);
    assert.equal(normalizeLang("", jsonOf(49_992)), "json");
    assert.equal(jsonOf(49_993).length, 50_001);
    assert.equal(normalizeLang("", jsonOf(49_993)), "plaintext");
    // ガード後は巨大でも JSON.parse を通さず失敗しない
  });
  it("does not mistake bullet lists or rules for diff", () => {
    // 同符号の `- ` 行が2つあるだけでは diff にしない（旧実装の誤判定）
    assert.equal(normalizeLang("", "- alpha\n- beta"), "plaintext");
    assert.equal(normalizeLang("", "- [ ] todo\n- [x] done"), "plaintext");
    // 水平線・front matter 系の `---` 単独も diff にしない
    assert.equal(normalizeLang("", "---\nbody\n---"), "plaintext");
    assert.equal(normalizeLang("", "intro\n\n---\n\noutro"), "plaintext");
    // 旧実装は `--- ` 行（`--- ` で終わる水平線/front matter）1本で diff にしていた
    assert.equal(normalizeLang("", "intro\n\n--- draft\n\noutro"), "plaintext");
    // 配列インデックス表記と大文字の index 行は git の blob ハッシュ行ではない
    assert.equal(normalizeLang("", "index 0..10"), "plaintext");
    assert.equal(normalizeLang("", "INDEX ABCDEF..1234567"), "plaintext");
  });
  it("detects real diffs by structure", () => {
    // unified diff のハンクヘッダ
    assert.equal(
      normalizeLang("", "@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n"),
      "diff",
    );
    // `--- a/...` と `+++ b/...` の対＋ハンク
    assert.equal(
      normalizeLang(
        "",
        "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      ),
      "diff",
    );
    // git のファイルヘッダ行と index 行
    assert.equal(
      normalizeLang(
        "",
        "diff --git a/x.ts b/x.ts\nindex 1234567..89abcde 100644\n",
      ),
      "diff",
    );
    assert.equal(normalizeLang("", "index abcdef1..1234567\n"), "diff");
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
  });
  it("returns escaped plain text once over the size guard", () => {
    // 実装のガードは `raw.length > 20000`（highlight.ts）。
    // ちょうど 20000 字では発動しないため、必ず超過する長さにする
    const raw = `<b>${"a".repeat(20001)}`;
    assert.equal(raw.length, 20004);
    // ガード発動時は esc 済みのまま返ることを値で検証する（doesNotThrow だけでは不可）
    assert.equal(
      highlightTokens(raw, "python"),
      `&lt;b&gt;${"a".repeat(20001)}`,
    );
    assert.equal(highlightTokens(raw, "python").includes("hljs-"), false);
    // 逆方向の検証: 本来ハイライトされる python を巨大化したもの。
    // ガードが効いていなければ hljs-keyword 等の span が付くため、
    // esc 済みと完全一致すること＝ガードが発動したことを意味する
    const py = "def f(x):\n  return x < 100\n";
    assert.match(highlightTokens(py, "python"), /hljs-/);
    const padded = py + "a".repeat(20000);
    assert.ok(padded.length > 20000);
    assert.equal(highlightTokens(padded, "python"), esc(padded));
    assert.equal(highlightTokens(padded, "python").includes("hljs-"), false);
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
  it("colors real diffs but leaves bullet lists plain", () => {
    // 言語タグなし fence は normalizeLang の自動判定に依存する
    const bullets = renderProse("```\n- alpha\n- beta\n```", []);
    assert.equal(bullets.includes("hljs-addition"), false);
    assert.equal(bullets.includes("hljs-deletion"), false);
    const diff = renderProse("```diff\n-old\n+new\n```", []);
    assert.match(diff, /hljs-(?:addition|deletion)/);
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
  it("keeps http, https and mailto links", () => {
    const mail = renderProse("[mail](mailto:a@example.com)", []);
    assert.ok(mail.includes('<a href="mailto:a@example.com"'));
    assert.ok(mail.includes('rel="noopener noreferrer"'));
    const page = renderProse("[page](https://example.com/x)", []);
    assert.ok(page.includes('<a href="https://example.com/x"'));
  });
  it("drops links whose URL contains whitespace", () => {
    // mdSanitizeUrl は空白を含む URL を拒否する。
    // marked は <> で包んだ空白入りリンク先をそのまま href に渡してくる
    const out = renderProse("[x](<http://exa mple.com>)", []);
    assert.equal(out.includes("<a"), false);
    assert.match(out, /<p>x<\/p>/);
  });
  it("drops every scheme other than http, https and mailto", () => {
    const ftp = renderProse("[x](ftp://a/b)", []);
    assert.equal(ftp.includes("<a"), false);
    const data = renderProse("[x](data:text/html,y)", []);
    assert.equal(data.includes("<a"), false);
    const js = renderProse("[x](javascript:alert(1))", []);
    assert.equal(js.includes("<a"), false);
  });
});
