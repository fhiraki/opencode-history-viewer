import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  highlightTokens,
  markTermsHtml,
  normalizeLang,
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
