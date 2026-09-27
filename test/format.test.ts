import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
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
  parseModel,
  prettyJson,
  shortenHome,
  tokensTotal,
} from "../src/shared/format.ts";

describe("fmtTime", () => {
  it("formats ms epoch in en-US", () => {
    // 固定 epoch はタイムゾーンで日付がずれるため、ローカル時刻で組み立てる
    const ms = new Date(2026, 8, 18, 12, 0).getTime();
    assert.match(fmtTime(ms), /^9\/18\/2026/);
  });
  it("returns - for missing values", () => {
    assert.equal(fmtTime(0), "-");
    // NaN / Infinity は Date にできないため同じく "-"（そのまま表示されない）
    assert.equal(fmtTime(Number.NaN), "-");
    assert.equal(fmtTime(Number.POSITIVE_INFINITY), "-");
  });
});

describe("parseModel / modelText", () => {
  it("parses JSON model strings", () => {
    assert.deepEqual(parseModel('{"id":"m","providerID":"p","variant":"x"}'), {
      provider: "p",
      id: "m",
      variant: "x",
    });
    assert.equal(
      modelText('{"id":"m","providerID":"p","variant":"x"}'),
      "p/m · x",
    );
  });
  it("falls back to plain strings", () => {
    assert.equal(modelText("legacy-model"), "legacy-model");
  });
  it("accepts an already-parsed object", () => {
    const model = { providerID: "p", id: "m", variant: "x" };
    const expected = { provider: "p", id: "m", variant: "x" };
    assert.deepEqual(parseModel(model), expected);
    // 文字列として受け取っても同じ形に畳める
    assert.deepEqual(parseModel('{"id":"m","providerID":"p"}'), {
      provider: "p",
      id: "m",
      variant: "",
    });
  });
  it("falls back to modelID when the id key is missing", () => {
    const raw = '{"providerID":"p","modelID":"m2"}';
    const expected = { provider: "p", id: "m2", variant: "" };
    assert.deepEqual(parseModel(raw), expected);
    assert.equal(modelText('{"modelID":"only"}'), "only");
    // JSON でない文字列はプレーン文字列として id に載る
    assert.equal(parseModel("not json")?.id, "not json");
  });
  it("hides the default variant and empty models", () => {
    assert.equal(
      modelText('{"id":"m","providerID":"p","variant":"default"}'),
      "p/m",
    );
    assert.equal(modelText(null), "");
    assert.equal(modelText(""), "");
  });
});

describe("fmtCost", () => {
  it("adapts precision to magnitude", () => {
    assert.equal(fmtCost(0), "$0");
    assert.equal(fmtCost(0.003458), "$0.0035");
    assert.equal(fmtCost(0.0635806), "$0.064");
    assert.equal(fmtCost(10.35), "$10.35");
    assert.equal(fmtCost(1234.5), "$1,234.50");
  });
});

describe("fmtCount", () => {
  it("compacts large numbers with k/M/B units", () => {
    assert.equal(fmtCount(62), "62");
    assert.equal(fmtCount(999), "999");
    assert.equal(fmtCount(13675), "13.7k");
    assert.equal(fmtCount(890306), "890.3k");
    assert.equal(fmtCount(130673305), "130.7M");
    assert.equal(fmtCount(2000000000), "2B");
  });
  it("promotes units at rounding boundaries", () => {
    assert.equal(fmtCount(999950), "1M");
    assert.equal(fmtCount(999499), "999.5k");
  });
});

describe("fmtExact", () => {
  it("uses en-US thousands separators", () => {
    assert.equal(fmtExact(62), "62");
    assert.equal(fmtExact(130673305), "130,673,305");
  });
});

describe("fmtDuration / fmtRange", () => {
  it("formats minute / hour / day durations", () => {
    assert.equal(fmtDuration(55 * 60000), "55 min");
    assert.equal(fmtDuration(70 * 60000), "1h 10m");
    assert.equal(fmtDuration(60 * 60000), "1h");
    assert.equal(fmtDuration(3 * 86400000 + 60000), "3d 0h");
  });
  it("renders a compact same-day range", () => {
    const from = new Date(2026, 8, 18, 0, 13).getTime();
    const to = new Date(2026, 8, 18, 1, 8).getTime();
    assert.equal(fmtRange(from, to), "9/18 0:13 → 1:08 (55 min)");
  });
  it("renders both dates when the range crosses midnight", () => {
    const from = new Date(2026, 8, 17, 23, 0).getTime();
    const to = new Date(2026, 8, 18, 1, 0).getTime();
    assert.equal(fmtRange(from, to), "9/17 23:00 → 9/18 1:00 (2h)");
  });
  it("keeps the same-day form for a late-evening span", () => {
    const from = new Date(2026, 8, 18, 23, 30).getTime();
    const to = new Date(2026, 8, 18, 23, 45).getTime();
    assert.equal(fmtRange(from, to), "9/18 23:30 → 23:45 (15 min)");
  });
});

describe("fmtDayWithWeekday", () => {
  it("appends the English weekday to YYYY-MM-DD", () => {
    // 年月日からローカル Date を組み立てるためタイムゾーンずれなし
    assert.equal(fmtDayWithWeekday("2026-09-19"), "2026-09-19 (Sat)");
    assert.equal(fmtDayWithWeekday("2026-09-18"), "2026-09-18 (Fri)");
  });
  it("passes through invalid dates untouched", () => {
    assert.equal(fmtDayWithWeekday(""), "");
    assert.equal(fmtDayWithWeekday("not-a-date"), "not-a-date");
    assert.equal(fmtDayWithWeekday("2026-02-30"), "2026-02-30");
  });
});

describe("esc / prettyJson", () => {
  it("escapes HTML special chars", () => {
    assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
    // シングルクォートはエスケープしない（属性の区切りに使わないため）
    assert.equal(esc("'"), "'");
    assert.equal(esc("it's"), "it's");
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });
  it("pretty-prints JSON and passes through the rest", () => {
    assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(prettyJson("not json"), "not json");
  });
});

describe("shortenHome", () => {
  // 実行環境のホームをそのまま使い、テスト内に個人のパスを書かない
  const home = os.homedir();
  it("shortens paths under home to ~/ notation", () => {
    assert.equal(shortenHome(`${home}/work/x`, home), "~/work/x");
    assert.equal(shortenHome(home, home), "~");
  });
  it("leaves non-matching and empty values untouched", () => {
    assert.equal(shortenHome("/tmp/x", home), "/tmp/x");
    assert.equal(shortenHome(`${home}2/x`, home), `${home}2/x`);
    assert.equal(shortenHome("", home), "");
    assert.equal(shortenHome("/a/b", ""), "/a/b");
  });
});

describe("tokensTotal", () => {
  it("sums input, output and reasoning and ignores cache", () => {
    assert.equal(
      tokensTotal({
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 999 },
      }),
      125,
    );
  });
  it("returns 0 when there is nothing to show so the label stays hidden", () => {
    // 合計 0 のときは呼び出し側が出力を出さない（数字なしの "tok" を消すため）
    assert.equal(tokensTotal(null), 0);
    assert.equal(tokensTotal(undefined), 0);
    assert.equal(tokensTotal({}), 0);
    assert.equal(tokensTotal({ input: 0, output: 0, reasoning: 0 }), 0);
    assert.equal(tokensTotal({ input: -5, output: Number.NaN }), 0);
  });
  it("falls back to total only when no component is present", () => {
    // total は実 DB に存在しない旧形式。コンポーネントが有る場合はそちらを優先する
    assert.equal(tokensTotal({ total: 42 }), 42);
    assert.equal(tokensTotal({ input: 1, total: 42 }), 1);
    assert.equal(tokensTotal({ total: Number.POSITIVE_INFINITY }), 0);
  });
});
