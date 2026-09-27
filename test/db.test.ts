import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  defaultDbPath,
  escapeLike,
  getSessionDetail,
  getStats,
  getTimeline,
  listProjects,
  listSessions,
  openDb,
  searchParts,
} from "../src/db.ts";
import { dayStr, fixture } from "./fixture.ts";

/** listSessions の戻り値から id の配列を取り出す（期待値との比較用） */
const ids = (r: ReturnType<typeof listSessions>): string[] =>
  r.sessions.map((s) => String(s.id));

/** getTimeline の戻り値の1日ぶん（date の昇順/降順は呼び出し側で担保する） */
type TimelineDay = ReturnType<typeof getTimeline>[number];

const dayOf = (days: TimelineDay[], date: string): TimelineDay => {
  const found = days.find((d) => d.date === date);
  assert.ok(found, `no timeline entry for ${date}`);
  return found;
};

describe("escapeLike", () => {
  it("escapes %, _ and backslash for LIKE ... ESCAPE", () => {
    assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d");
    assert.equal(escapeLike("plain"), "plain");
  });
});

describe("listSessions preview", () => {
  it("prefers the first user text, skipping empty parts", () => {
    const db = fixture();
    try {
      const { sessions } = listSessions(db, {});
      const byId = new Map(sessions.map((s) => [String(s.id), s]));
      assert.equal(byId.get("s1")?.preview, "user question alpha");
      assert.equal(byId.get("s2")?.preview, "only answer");
      assert.equal(byId.get("s3")?.preview, "progress 100% done");
    } finally {
      db.close();
    }
  });
  it("orders by time_updated DESC by default, and by time_created when asked", () => {
    const db = fixture();
    try {
      const { total } = listSessions(db, {});
      assert.equal(total, 3);
      // time_updated は 9/20 > 9/19 > 9/17 で一意
      assert.deepEqual(ids(listSessions(db, {})), ["s3", "s2", "s1"]);
      // sort=created も time_created で並ぶ（フィルタ基準と同じ）
      const byCreated = listSessions(db, { sort: "created" });
      assert.deepEqual(ids(byCreated), ["s3", "s2", "s1"]);
    } finally {
      db.close();
    }
  });
  it("orders by id as a tiebreaker for equal timestamps", () => {
    const db = fixture();
    try {
      // 同一タイムスタンプの行は id 降順で決定的に並ぶ（ソートがぶれないこと）
      const tie = new Date(2026, 8, 26, 12, 0).getTime();
      const ins = db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created,
          time_updated) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      ins.run("tieA", "p1", "/tmp/x", "tie a", tie, tie);
      ins.run("tieB", "p1", "/tmp/x", "tie b", tie, tie);
      // "tieA" < "tieB" なので id DESC では tieB が先
      const expected = ["tieB", "tieA"];
      assert.deepEqual(ids(listSessions(db, { limit: 2 })), expected);
      const byCreated = listSessions(db, { limit: 2, sort: "created" });
      assert.deepEqual(ids(byCreated), expected);
      const all = listSessions(db, { sort: "created" });
      assert.equal(all.total, 5);
      const expectedAll = ["tieB", "tieA", "s3", "s2", "s1"];
      assert.deepEqual(ids(all), expectedAll);
    } finally {
      db.close();
    }
  });
});

describe("listSessions filters", () => {
  it("matches title and directory through escapeLike", () => {
    const db = fixture();
    try {
      const byTitle = listSessions(db, { q: "second" });
      assert.deepEqual(ids(byTitle), ["s2"]);
      // title に無い文字列は directory で一致する
      const byDir = listSessions(db, { q: "/work/beta" });
      assert.deepEqual(ids(byDir), ["s3"]);
      const both = listSessions(db, { q: "alpha_dir" });
      assert.equal(both.total, 2);
      // "_" は任意1文字ではなくリテラル（エスケープが効いていれば
      // directory に "_" を含む2件だけが一致する）
      const underscore = listSessions(db, { q: "_" });
      assert.equal(underscore.total, 2);
      assert.deepEqual(ids(underscore), ["s2", "s1"]);
      // "%" もリテラル（タイトル・ディレクトリに無い）
      assert.equal(listSessions(db, { q: "%" }).total, 0);
      assert.equal(listSessions(db, { q: "no-such-title" }).total, 0);
    } finally {
      db.close();
    }
  });

  it("filters by project and keeps total beyond the last page", () => {
    const db = fixture();
    try {
      const p1 = listSessions(db, { project: "p1" });
      assert.equal(p1.total, 2);
      assert.deepEqual(ids(p1), ["s2", "s1"]);
      const p2 = listSessions(db, { project: "p2" });
      assert.equal(p2.total, 1);
      assert.deepEqual(ids(p2), ["s3"]);
      const unknown = listSessions(db, { project: "nope" });
      assert.equal(unknown.total, 0);
      assert.deepEqual(unknown.sessions, []);
      // offset が範囲外でも 0 件ではなく total が保たれる
      const beyond = listSessions(db, { offset: 3, limit: 10 });
      assert.equal(beyond.total, 3);
      assert.deepEqual(beyond.sessions, []);
      const page2 = listSessions(db, { offset: 1, limit: 1 });
      assert.equal(page2.total, 3);
      assert.deepEqual(ids(page2), ["s2"]);
      // q と project は AND で効く
      const combined = listSessions(db, { project: "p1", q: "beta" });
      assert.equal(combined.total, 0);
      assert.deepEqual(combined.sessions, []);
    } finally {
      db.close();
    }
  });

  it("returns messageCount and the cost/tokens/agent/model columns", () => {
    const db = fixture();
    try {
      const { sessions } = listSessions(db, {});
      const s1 = sessions.find((s) => String(s.id) === "s1");
      assert.ok(s1);
      assert.equal(s1.messageCount, 2);
      const s2 = sessions.find((s) => String(s.id) === "s2");
      assert.ok(s2);
      assert.equal(s2.messageCount, 1);
      const s3 = sessions.find((s) => String(s.id) === "s3");
      assert.ok(s3);
      assert.equal(s3.messageCount, 1);
      // session に投入した列がそのまま返ること（stats の SUM 元データ）
      assert.equal(s1.cost, 1.25);
      assert.equal(s1.tokens_input, 1000);
      assert.equal(s1.tokens_cache_read, 100);
      assert.equal(s1.agent, "build");
      assert.equal(
        s1.model,
        '{"id":"m1","providerID":"prov","variant":"default"}',
      );
      assert.equal(s2.model, "legacy-model");
      assert.equal(s3.cost, 0.25);
      assert.equal(s3.agent, null);
    } finally {
      db.close();
    }
  });
});

describe("getSessionDetail caps", () => {
  type DetailPart = {
    id: string;
    text?: string;
    truncated?: boolean;
    fullLength?: number;
    input?: string;
    inputTruncated?: boolean;
    output?: string;
    outputTruncated?: boolean;
    outputFullLength?: number;
  };
  it("truncates long text and tool payloads with metadata", () => {
    const db = fixture();
    try {
      const detail = getSessionDetail(db, "s1") as unknown as {
        messages: { parts: DetailPart[] }[];
      } | null;
      assert.ok(detail);
      const parts = detail.messages.flatMap((m) => m.parts);
      const longText = parts.find((p) => p.id === "p5");
      assert.equal(longText?.truncated, true);
      assert.equal(longText?.text?.length, 8000);
      assert.equal(longText?.fullLength, 9000);
      const longTool = parts.find((p) => p.id === "p6");
      assert.equal(longTool?.inputTruncated, true);
      assert.equal(longTool?.input?.length, 4000);
      assert.equal(longTool?.outputTruncated, true);
      assert.equal(longTool?.output?.length, 8000);
      assert.equal(longTool?.outputFullLength, 9000);
    } finally {
      db.close();
    }
  });
});

describe("tool title caps", () => {
  it("caps the detail title and the search title at 1000 chars", () => {
    const db = fixture();
    try {
      // 実 DB で観測された巨大 state.title（26,065 文字）を模した 3000 文字の
      // title を fixture の p16 として用意してある
      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: { id: string; title?: unknown }[] }[];
      } | null;
      assert.ok(detail);
      const capPart = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "p16");
      assert.ok(capPart);
      const title = typeof capPart.title === "string" ? capPart.title : "";
      assert.equal(title.length, 1000);
      assert.ok(title.startsWith("titlecapstart"));

      // 先頭付近の語で検索しないとスニペット源（caps 済み title）から消える
      const { total, hits } = searchParts(db, { q: "titlecapstart" });
      assert.equal(total, 1);
      assert.equal(String(hits[0]?.part_id), "p16");
      const hitTitle = typeof hits[0]?.title === "string" ? hits[0].title : "";
      assert.equal(hitTitle.length, 1000);
      // ヒット語は先頭にあるため prefix "…" は付かず 120 文字ぶんだけ後ろを取る
      const snippet = String(hits[0]?.snippet);
      assert.equal(snippet, `titlecapstart ${"x".repeat(119)}`);
    } finally {
      db.close();
    }
  });
});

describe("searchParts snippet", () => {
  it("finds term matches with a positioned snippet", () => {
    const db = fixture();
    try {
      const { total, hits } = searchParts(db, { q: "alpha" });
      // 全件返す回帰でも通らないよう件数と id を実データで固定する
      assert.equal(total, 1);
      assert.deepEqual(
        hits.map((h) => h.part_id),
        ["p1"],
      );
      assert.equal(hits[0]?.session_id, "s1");
      assert.equal(hits[0]?.part_type, "text");
      // 短い本文は prefix "…" なしで全文がスニペットになる
      assert.equal(hits[0]?.snippet, "user question alpha");
    } finally {
      db.close();
    }
  });
  it("centers the snippet on the hit with a 120 char radius", () => {
    const db = fixture();
    try {
      // p5 の本文 9000 文字の中央（index 4440）に置いた語（大文字でも一致する）
      const { total, hits } = searchParts(db, { q: "midterm" });
      assert.equal(total, 1);
      assert.deepEqual(
        hits.map((h) => h.part_id),
        ["p5"],
      );
      const snippet = String(hits[0]?.snippet);
      // 前後に120文字、prefix "…" 1文字 → 1 + 120 + 7 + 120 = 248
      assert.equal(snippet.length, 248);
      assert.ok(snippet.startsWith("…"));
      assert.equal(snippet.indexOf("MIDTERM"), 121);
      assert.equal(snippet.slice(1, 121), "a".repeat(120));
      assert.equal(snippet.slice(128), "b".repeat(120));
      // 開始側が 0 なら "…" は付かない（fixture の先頭ヒットで確認）
      const head = searchParts(db, { q: "toofar" });
      assert.equal(head.total, 1);
      assert.equal(String(head.hits[0]?.part_id), "p5");
      assert.equal(String(head.hits[0]?.snippet).startsWith("…"), false);
    } finally {
      db.close();
    }
  });
  it("returns empty for blank queries", () => {
    const db = fixture();
    try {
      assert.deepEqual(searchParts(db, { q: "   " }), { total: 0, hits: [] });
    } finally {
      db.close();
    }
  });
  it("ignores JSON key names that are not displayed", () => {
    const db = fixture();
    try {
      // "type" は全 part の JSON キーだが表示内容には現れない
      assert.equal(searchParts(db, { q: "type" }).total, 0);
      // tool 入力は表示対象なのでキー名も検索できる
      assert.equal(searchParts(db, { q: "filePath" }).total, 1);
    } finally {
      db.close();
    }
  });
  it("keeps the total when the requested page is beyond the hits", () => {
    const db = fixture();
    try {
      // offset 超過で 0 件でも COUNT(*) OVER () の値が取れないケースを数え直して返す
      const { total, hits } = searchParts(db, {
        q: "alpha",
        offset: 50,
        limit: 50,
      });
      assert.equal(total, 1);
      assert.equal(hits.length, 0);
    } finally {
      db.close();
    }
  });
  it("treats % and _ literally via escapeLike", () => {
    const db = fixture();
    try {
      // エスケープが効いていなければ decoy までヒットする。存在しない語だけを
      // 使っているとエスケープを外しても同じ結果になり、検証力が無い
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "decoyEsc",
        "m1",
        "s1",
        1,
        1,
        JSON.stringify({ type: "text", text: "progress 100Z1 decoy" }),
      );
      // decoy が実際に検索で引っかかる（＝上の2件がエスケープの効きで分かれている）
      assert.equal(searchParts(db, { q: "decoy" }).total, 1);
      assert.equal(searchParts(db, { q: "100%" }).total, 1);
      assert.equal(searchParts(db, { q: "100_1" }).total, 0);
    } finally {
      db.close();
    }
  });
  it("matches terms with quotes and backslashes via the JSON-escaped prefilter", () => {
    const db = fixture();
    try {
      assert.equal(searchParts(db, { q: 'say "hi"' }).total, 1);
      assert.equal(searchParts(db, { q: "C:\\path" }).total, 1);
    } finally {
      db.close();
    }
  });
  it("caps displayed fields while still matching the full value", () => {
    const db = fixture();
    try {
      // t_text 8000: 語は 8500 文字目。ヒットはするがスニペット源には無い
      const text = searchParts(db, { q: "toofar" });
      assert.equal(text.total, 1);
      assert.deepEqual(
        text.hits.map((h) => h.part_id),
        ["p5"],
      );
      assert.equal(text.hits[0]?.snippet, "a".repeat(240));
      // reasoning も同じ t_text の経路を通る
      const reasoning = searchParts(db, { q: "reasontail" });
      assert.equal(reasoning.total, 1);
      assert.deepEqual(
        reasoning.hits.map((h) => h.part_id),
        ["p9"],
      );
      assert.equal(reasoning.hits[0]?.snippet, "r".repeat(240));
      // t_input 4000（json_extract は state.input を JSON 表記で返す）
      // スニペット源は title + input + output の連結で、p6 は title 無し
      const inputPrefix = `{"command":"${"y".repeat(228)}`;
      const input = searchParts(db, { q: "inputtail" });
      assert.equal(input.total, 1);
      assert.deepEqual(
        input.hits.map((h) => h.part_id),
        ["p6"],
      );
      assert.equal(input.hits[0]?.snippet, inputPrefix);
      // t_output 8000（input が先に来るためスニペット先頭は input のまま）
      const output = searchParts(db, { q: "outputtail" });
      assert.equal(output.total, 1);
      assert.deepEqual(
        output.hits.map((h) => h.part_id),
        ["p6"],
      );
      assert.equal(output.hits[0]?.snippet, inputPrefix);
      // t_files 2000（"patch " を前に付けて返す）
      const files = searchParts(db, { q: "filetail" });
      assert.equal(files.total, 1);
      assert.deepEqual(
        files.hits.map((h) => h.part_id),
        ["p10"],
      );
      const filesSnippet = String(files.hits[0]?.snippet);
      assert.ok(filesSnippet.startsWith("patch ["));
      assert.equal(filesSnippet.includes("FILETAIL"), false);
    } finally {
      db.close();
    }
  });
  it("orders by time_created DESC then id DESC and pages with total", () => {
    const db = fixture();
    try {
      const first = searchParts(db, { q: "tiebreak", limit: 1 });
      assert.equal(first.total, 2);
      assert.deepEqual(
        first.hits.map((h) => h.part_id),
        ["tieB"],
      );
      const second = searchParts(db, { q: "tiebreak", limit: 1, offset: 1 });
      assert.equal(second.total, 2);
      assert.deepEqual(
        second.hits.map((h) => h.part_id),
        ["tieA"],
      );
      // offset 超過で0件のときだけ COUNT(*) を数え直して total を返す
      const beyond = searchParts(db, { q: "tiebreak", limit: 1, offset: 2 });
      assert.equal(beyond.total, 2);
      assert.deepEqual(beyond.hits, []);
      // project で絞り込める（tiebreak は p1 配下のセッションだけ）
      const other = searchParts(db, { q: "tiebreak", project: "p2" });
      assert.equal(other.total, 0);
      assert.deepEqual(other.hits, []);
      const same = searchParts(db, { q: "tiebreak", project: "p1" });
      assert.equal(same.total, 2);
    } finally {
      db.close();
    }
  });
});

describe("getTimeline", () => {
  it("buckets sessions, messages, cost and titles by local day", () => {
    const db = fixture();
    try {
      const d17 = new Date(2026, 8, 17);
      const d19 = new Date(2026, 8, 19);
      const d20 = new Date(2026, 8, 20);
      const days = getTimeline(db);
      // 日付は新しい順（降順）。固定 epoch でなくローカル時刻で組み立てた日付
      const expectedDates = [dayStr(d20), dayStr(d19), dayStr(d17)];
      assert.deepEqual(
        days.map((d) => d.date),
        expectedDates,
      );
      const on17 = dayOf(days, dayStr(d17));
      assert.equal(on17.sessions, 1);
      assert.equal(on17.messages, 2);
      assert.equal(on17.cost, 1.25);
      assert.deepEqual(on17.titles, ["first"]);
      const on19 = dayOf(days, dayStr(d19));
      assert.equal(on19.sessions, 1);
      assert.equal(on19.messages, 1);
      assert.equal(on19.cost, 0.5);
      assert.deepEqual(on19.titles, ["second"]);
      const on20 = dayOf(days, dayStr(d20));
      assert.equal(on20.sessions, 1);
      assert.equal(on20.messages, 1);
      assert.equal(on20.cost, 0.25);
      assert.deepEqual(on20.titles, ["third"]);
    } finally {
      db.close();
    }
  });

  it("keeps only the newest five titles per day in id DESC order", () => {
    const db = fixture();
    try {
      const base = new Date(2026, 8, 22, 10, 0).getTime();
      const rows: [string, string, number][] = [
        ["t1", "one", base],
        ["t2", "two", base + 60_000],
        ["t3", "three", base + 120_000],
        ["t4", "four", base + 180_000],
        ["t5", "five", base + 240_000],
        ["t6", "six", base + 240_000],
      ];
      const ins = db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created,
          time_updated) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const [id, title, at] of rows) {
        ins.run(id, "p1", "/tmp/x", title, at, at);
      }
      const days = getTimeline(db);
      assert.equal(days.length, 4);
      const day = dayOf(days, dayStr(new Date(2026, 8, 22)));
      assert.equal(day.sessions, 6);
      // 上限5件。同時刻の t5/t6 は id DESC で t6 が先、最古の t1 は落ちる
      assert.deepEqual(day.titles, ["six", "five", "four", "three", "two"]);
    } finally {
      db.close();
    }
  });

  it("restricts days, messages and titles to one project", () => {
    const db = fixture();
    try {
      const d17 = dayStr(new Date(2026, 8, 17));
      const d19 = dayStr(new Date(2026, 8, 19));
      const d20 = dayStr(new Date(2026, 8, 20));
      const p1 = getTimeline(db, { project: "p1" });
      assert.deepEqual(
        p1.map((d) => d.date),
        [d19, d17],
      );
      assert.equal(dayOf(p1, d17).messages, 2);
      assert.equal(dayOf(p1, d19).messages, 1);
      assert.equal(dayOf(p1, d19).cost, 0.5);
      const p2 = getTimeline(db, { project: "p2" });
      assert.deepEqual(
        p2.map((d) => d.date),
        [d20],
      );
      assert.deepEqual(dayOf(p2, d20).titles, ["third"]);
      assert.equal(dayOf(p2, d20).messages, 1);
      assert.deepEqual(getTimeline(db, { project: "nope" }), []);
    } finally {
      db.close();
    }
  });
});

describe("listSessions from/to", () => {
  it("filters on time_created so it matches getTimeline's day buckets", () => {
    const db = fixture();
    try {
      // time_created=日X・time_updated=日Y（X≠Y）のセッション
      const dayX = new Date(2026, 8, 18, 12, 0);
      const dayY = new Date(2026, 8, 25, 12, 0);
      db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sDrift", "p1", "/tmp/x", "drift", dayX.getTime(), dayY.getTime());

      // タイムラインは time_created でバケットするため日 X に計上され、日 Y には出ない
      const days = getTimeline(db);
      const entryX = days.find((d) => d.titles.includes("drift"));
      assert.ok(entryX);
      assert.equal(entryX.date, dayStr(dayX));
      assert.equal(entryX.sessions, 1);
      assert.equal(
        days.some((d) => d.date === dayStr(dayY)),
        false,
      );

      // 日クリックと同じ 00:00〜23:59:59.999 の範囲（タイムラインの日 X と一致すること）
      const rangeOf = (d: Date) => {
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const end = new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate() + 1,
          -1,
        );
        return { from: start.getTime(), to: end.getTime() };
      };
      const inX = listSessions(db, rangeOf(dayX));
      assert.equal(inX.total, 1);
      assert.equal(String(inX.sessions[0]?.id), "sDrift");
      const inY = listSessions(db, rangeOf(dayY));
      assert.equal(inY.total, 0);
      assert.equal(inY.sessions.length, 0);
    } finally {
      db.close();
    }
  });

  it("keeps the day range on time_created for any sort and orders by created when asked", () => {
    const db = fixture();
    try {
      const dayX = new Date(2026, 8, 18, 12, 0);
      const dayY = new Date(2026, 8, 25, 12, 0);
      const start = new Date(2026, 8, 18).getTime();
      const to = new Date(2026, 8, 18, 23, 59, 59, 999).getTime();
      const ins = db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // 同一日（日X）に作成され、更新日が異なる2件。updated 順と created 順が逆転する
      ins.run("sA", "p1", "/tmp/x", "a", dayX.getTime(), dayY.getTime());
      ins.run(
        "sB",
        "p1",
        "/tmp/x",
        "b",
        new Date(2026, 8, 18, 18, 0).getTime(),
        new Date(2026, 8, 18, 13, 0).getTime(),
      );

      // クライアントはタイムライン日別絞り込み中に sort=created を送る（フィルタ基準と揃える）
      const byCreated = listSessions(db, { from: start, to, sort: "created" });
      assert.deepEqual(
        byCreated.sessions.map((s) => String(s.id)),
        ["sB", "sA"],
      );
      // sort を created に変えても絞り込み対象は変わらない（from/to は常に time_created）
      const byUpdated = listSessions(db, { from: start, to, sort: "updated" });
      assert.deepEqual(
        byUpdated.sessions.map((s) => String(s.id)),
        ["sA", "sB"],
      );
      assert.equal(byUpdated.total, 2);
    } finally {
      db.close();
    }
  });
});

describe("getSessionDetail message meta", () => {
  type DetailMessage = {
    id: string;
    role: string;
    time_created: number;
    time_updated: number;
    agent: unknown;
    modelID: unknown;
    tokens: unknown;
    cost: unknown;
    finish: unknown;
    parts: { id: string; type: string }[];
  };
  it("keeps the message shape after moving meta extraction into SQL", () => {
    const db = fixture();
    try {
      db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sMeta", "p1", "/tmp/x", "meta", 100, 100);
      const msg = db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // role / agent / modelID / model.modelID / tokens / cost / finish の完全形
      msg.run(
        "mm1",
        "sMeta",
        1,
        1,
        JSON.stringify({
          role: "assistant",
          agent: "build",
          modelID: "top-model",
          model: { providerID: "prov", modelID: "nested-model" },
          tokens: { input: 3, output: 2, reasoning: 1 },
          cost: 0.125,
          finish: "stop",
        }),
      );
      // modelID が無い行は model.modelID にフォールバックし、無いキーは null
      msg.run(
        "mm2",
        "sMeta",
        2,
        2,
        JSON.stringify({
          role: "user",
          model: { providerID: "prov", modelID: "nested-only" },
        }),
      );
      // 空文字 role・null tokens/cost・false finish は従来の truthy 判定どおり
      msg.run(
        "mm3",
        "sMeta",
        3,
        3,
        JSON.stringify({ role: "", tokens: null, cost: null, finish: false }),
      );

      const detail = getSessionDetail(db, "sMeta") as unknown as {
        messages: DetailMessage[];
      } | null;
      assert.ok(detail);
      assert.deepEqual(detail.messages[0], {
        id: "mm1",
        role: "assistant",
        time_created: 1,
        time_updated: 1,
        agent: "build",
        modelID: "top-model",
        tokens: { input: 3, output: 2, reasoning: 1 },
        cost: 0.125,
        finish: "stop",
        parts: [],
      });
      const m2 = detail.messages[1];
      assert.equal(m2?.modelID, "nested-only");
      assert.equal(m2?.agent, null);
      assert.equal(m2?.tokens, null);
      assert.equal(m2?.cost, null);
      assert.equal(m2?.finish, null);
      const m3 = detail.messages[2];
      assert.equal(m3?.role, "unknown");
      assert.equal(m3?.tokens, null);
      assert.equal(m3?.cost, null);
      assert.equal(m3?.finish, null);
    } finally {
      db.close();
    }
  });

  it('returns role: "unknown" / type: "unknown" for data: "null" instead of throwing', () => {
    const db = fixture();
    try {
      db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sNull", "p1", "/tmp/x", "null data", 100, 100);
      const msg = db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // JSON.parse の結果が null / 非オブジェクトでも TypeError にならず未知扱いになる
      msg.run("mn1", "sNull", 1, 1, "null");
      msg.run("mn2", "sNull", 2, 2, "123");
      msg.run("mn3", "sNull", 3, 3, '"plainstring"');
      const part = db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      part.run("pn1", "mn1", "sNull", 1, 1, "null");
      part.run("pn2", "mn2", "sNull", 2, 2, "123");
      part.run("pn3", "mn3", "sNull", 3, 3, '"plainstring"');

      const detail = getSessionDetail(db, "sNull") as unknown as {
        messages: DetailMessage[];
      } | null;
      assert.ok(detail);
      assert.equal(detail.messages.length, 3);
      for (const m of detail.messages) {
        assert.equal(m.role, "unknown");
        assert.equal(m.agent, null);
        assert.equal(m.modelID, null);
        assert.equal(m.tokens, null);
        assert.equal(m.cost, null);
        assert.equal(m.finish, null);
        assert.equal(m.parts[0]?.type, "unknown");
      }
    } finally {
      db.close();
    }
  });

  it("falls back to JS parsing instead of failing the whole detail", () => {
    const db = fixture();
    try {
      db.prepare(
        `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sBroken", "p1", "/tmp/x", "broken", 100, 100);
      const msg = db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // 開いた直後に閉じ括弧を欠いた切り詰め文字列。json_extract は
      // 「malformed JSON」で throw するため selectMessagesLegacy へ切り替わる
      msg.run("mb1", "sBroken", 1, 1, `{"role":"assistant","modelID":"m`);
      // 同じセッションの正常な行は従来どおり取れる（破損 1 行で全体が壊れない）
      msg.run("mb2", "sBroken", 2, 2, `{"role":"user","cost":0.5}`);

      const detail = getSessionDetail(db, "sBroken") as unknown as {
        messages: DetailMessage[];
      } | null;
      assert.ok(detail);
      assert.equal(detail.messages.length, 2);
      const broken = detail.messages[0];
      assert.equal(broken?.id, "mb1");
      assert.equal(broken?.role, "unknown");
      assert.equal(broken?.agent, null);
      assert.equal(broken?.modelID, null);
      assert.equal(broken?.tokens, null);
      assert.equal(broken?.cost, null);
      assert.equal(broken?.finish, null);
      assert.deepEqual(broken?.parts, []);
      const healthy = detail.messages[1];
      assert.equal(healthy?.id, "mb2");
      assert.equal(healthy?.role, "user");
      assert.equal(healthy?.cost, 0.5);
      assert.equal(healthy?.tokens, null);
    } finally {
      db.close();
    }
  });
});

describe("patch files caps", () => {
  type PatchPart = { id: string; files?: unknown };
  const insertPatch = (
    db: ReturnType<typeof fixture>,
    id: string,
    files: unknown[],
  ) => {
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "m4",
      "s3",
      40,
      40,
      JSON.stringify({ type: "patch", files, hash: "h" }),
    );
  };
  it("caps the detail files at 2000 chars in total", () => {
    const db = fixture();
    try {
      // 1 要素 300 文字 ×10（合計 3000 文字）。検索側は substr(...,1,2000) で cap 済み
      const files = Array.from({ length: 10 }, (_, i) =>
        `file-${i}-`.padEnd(300, "x"),
      );
      insertPatch(db, "pcap", files);

      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: PatchPart[] }[];
      } | null;
      assert.ok(detail);
      const part = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "pcap");
      const got = (part?.files ?? []) as string[];
      const total = got.reduce((n, f) => n + String(f).length, 0);
      assert.ok(total <= 2000, `files total ${total} > 2000`);
      // 先頭から残し、はみ出した要素は落とさず残り予算ぶんだけ切り詰める
      // （6×300=1800 で残り 200 ぶんの 7 件目まで入る＝検索側 substr と同じ切断）
      assert.equal(got.length, 7);
      assert.equal(got[0], files[0]);
      assert.equal(got[6], files[6].slice(0, 200));
      assert.equal(total, 2000);
    } finally {
      db.close();
    }
  });

  it("truncates a single element that exceeds the cap to the budget", () => {
    const db = fixture();
    try {
      insertPatch(db, "pcap1", ["y".repeat(3000)]);
      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: PatchPart[] }[];
      } | null;
      assert.ok(detail);
      const part = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "pcap1");
      // 落として空配列にすると検索ではヒットして詳細では何も出ないため、
      // 検索側の substr(...,1,2000) と同じ先頭 2000 文字を返す
      assert.deepEqual(part?.files, ["y".repeat(2000)]);
    } finally {
      db.close();
    }
  });

  it("drops a non-string element that exceeds the budget", () => {
    const db = fixture();
    try {
      // 非文字列は JSON 表記の長さぶんしか入れられないため従来どおり落とす
      insertPatch(db, "pcap4", [{ path: "z".repeat(3000) }]);
      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: PatchPart[] }[];
      } | null;
      assert.ok(detail);
      const part = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "pcap4");
      assert.deepEqual(part?.files, []);
    } finally {
      db.close();
    }
  });

  it("keeps files that fit the cap untouched", () => {
    const db = fixture();
    try {
      insertPatch(db, "pcap2", ["src/a.ts", "src/b.ts"]);
      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: PatchPart[] }[];
      } | null;
      assert.ok(detail);
      const part = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "pcap2");
      assert.deepEqual(part?.files, ["src/a.ts", "src/b.ts"]);
    } finally {
      db.close();
    }
  });
});

describe("getStats", () => {
  it("reports totals, tokens, range, per-project and tool usage", () => {
    const db = fixture();
    try {
      const stats = getStats(db);
      assert.equal(stats.sessionCount, 3);
      assert.equal(stats.messageCount, 4);
      assert.equal(stats.partCount, 19);
      // session に投入した cost / tokens 列の合計
      assert.deepEqual(stats.tokens, { ti: 1800, tout: 360, tr: 90, cost: 2 });
      // MIN(time_created) / MAX(time_updated)
      const minT = new Date(2026, 8, 17, 9, 0).getTime();
      const maxT = new Date(2026, 8, 20, 16, 0).getTime();
      assert.equal(stats.range?.minT, minT);
      assert.equal(stats.range?.maxT, maxT);
      // project 表と LEFT JOIN（p3 はセッション無しなので出ない）
      assert.equal(stats.perProject.length, 2);
      const p1row = stats.perProject[0];
      assert.equal(p1row?.id, "p1");
      assert.equal(p1row?.worktree, "/wt/alpha");
      assert.equal(p1row?.sessions, 2);
      assert.equal(p1row?.cost, 1.75);
      const p1Active = new Date(2026, 8, 19, 13, 0).getTime();
      assert.equal(p1row?.lastActive, p1Active);
      const p2row = stats.perProject[1];
      assert.equal(p2row?.id, "p2");
      // p2.worktree は NULL なので COALESCE で空文字になる
      assert.equal(p2row?.worktree, "");
      assert.equal(p2row?.sessions, 1);
      assert.equal(p2row?.cost, 0.25);
      const p2Active = new Date(2026, 8, 20, 16, 0).getTime();
      assert.equal(p2row?.lastActive, p2Active);
      const tools = new Map(stats.toolUsage.map((t) => [String(t.tool), t.c]));
      assert.equal(tools.get("read"), 1);
      assert.equal(tools.get("bash"), 1);
      assert.equal(tools.get("edit"), 1);
    } finally {
      db.close();
    }
  });

  it("returns at most the 20 most used tools", () => {
    const db = fixture();
    try {
      const ins = db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created,
          time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const expected: string[] = [];
      for (let i = 0; i < 20; i++) {
        const name = `tool${String(i).padStart(2, "0")}`;
        expected.push(name);
        const data = JSON.stringify({ type: "tool", tool: name, state: {} });
        // 2回ずつ＝カウント2で、フィクスチャ分（カウント1）を締め出す
        ins.run(`a${i}`, "m4", "s3", 200 + i, 200 + i, data);
        ins.run(`b${i}`, "m4", "s3", 200 + i, 200 + i, data);
      }
      const usage = getStats(db).toolUsage;
      assert.equal(usage.length, 20);
      assert.ok(usage.every((u) => u.c === 2));
      assert.deepEqual(
        usage.map((u) => u.tool),
        expected,
      );
      assert.equal(
        usage.some((u) => u.tool === "read"),
        false,
      );
    } finally {
      db.close();
    }
  });

  it("extracts tool names from the data head and falls back for odd shapes", () => {
    const db = fixture();
    try {
      const part = db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // 旧形式で tool キーが先頭に無い行（json_extract フォールバック対象）
      part.run(
        "t1",
        "m4",
        "s3",
        10,
        10,
        '{"type":"tool","callID":"c1","state":{},"tool":"grep"}',
      );
      // tool キー自体が無い行は (unknown) に寄せる
      part.run("t2", "m4", "s3", 11, 11, '{"type":"tool","callID":"c2"}');
      // 本文中に JSON 断片（エスケープ済み）を含む text は tool として数えない
      part.run(
        "t3",
        "m4",
        "s3",
        12,
        12,
        JSON.stringify({
          type: "text",
          text: 'example: {"type":"tool","tool":"fake"}',
        }),
      );
      const tools = new Map(
        getStats(db).toolUsage.map((t) => [String(t.tool), t.c]),
      );
      assert.equal(tools.get("read"), 1);
      assert.equal(tools.get("bash"), 1);
      assert.equal(tools.get("grep"), 1);
      assert.equal(tools.get("(unknown)"), 1);
      assert.equal(tools.has("fake"), false);
    } finally {
      db.close();
    }
  });

  it("aggregates per-model stats from assistant messages only", () => {
    const db = fixture();
    try {
      const msg = db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      );
      msg.run(
        "m5",
        "s3",
        5,
        5,
        '{"role":"assistant","providerID":"prov","modelID":"mm","cost":0.5,' +
          '"tokens":{"input":10,"output":4,"reasoning":1},' +
          '"time":{"created":100,"completed":300}}',
      );
      // ネストした role:assistant は prefilter で拾われても json_extract の role で除外する
      msg.run("m6", "s3", 6, 6, '{"role":"user","extra":{"role":"assistant"}}');
      const rows = getStats(db).perModel;
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      assert.equal(byId.get("mm")?.provider, "prov");
      assert.equal(byId.get("mm")?.messages, 1);
      assert.equal(byId.get("mm")?.cost, 0.5);
      assert.equal(byId.get("mm")?.ti, 10);
      assert.equal(byId.get("mm")?.tout, 4);
      assert.equal(byId.get("mm")?.tr, 1);
      assert.equal(byId.get("mm")?.activeMs, 200);
      const total = rows.reduce((n, r) => n + Number(r.messages), 0);
      assert.equal(total, 3); // m2 / m3 / m5
    } finally {
      db.close();
    }
  });
});

describe("listProjects", () => {
  it("lists every project with counts ordered by lastActive DESC", () => {
    const db = fixture();
    try {
      const projects = listProjects(db);
      assert.deepEqual(
        projects.map((p) => p.id),
        ["p2", "p1", "p3"],
      );
      const p2row = projects[0];
      assert.equal(p2row?.name, "Beta");
      assert.equal(p2row?.worktree, null);
      assert.equal(p2row?.sessionCount, 1);
      const p1row = projects[1];
      assert.equal(p1row?.name, "Alpha");
      assert.equal(p1row?.worktree, "/wt/alpha");
      assert.equal(p1row?.sessionCount, 2);
      const p1Active = new Date(2026, 8, 19, 13, 0).getTime();
      assert.equal(p1row?.lastActive, p1Active);
      // セッションを持たない project も LEFT JOIN で落ちずに残る
      const p3row = projects[2];
      assert.equal(p3row?.sessionCount, 0);
      assert.equal(p3row?.lastActive, null);
    } finally {
      db.close();
    }
  });
});

describe("getSessionDetail part types", () => {
  it("normalizes every part type with its own caps", () => {
    const db = fixture();
    try {
      const parts = new Map<string, Record<string, unknown>>();
      for (const sid of ["s1", "s2", "s3"]) {
        const detail = getSessionDetail(db, sid) as unknown as {
          messages: { parts: Record<string, unknown>[] }[];
        } | null;
        assert.ok(detail);
        for (const message of detail.messages) {
          for (const part of message.parts) {
            parts.set(String(part.id), part);
          }
        }
      }
      assert.equal(parts.size, 19);

      // 空 text は detail では残る（プレビュー側でだけスキップされる）
      assert.equal(parts.get("p0")?.text, "");
      assert.equal(parts.get("p1")?.text, "user question alpha");
      // reasoning は text と同じ 8000 字 caps
      const reasoning = parts.get("p9");
      assert.equal(reasoning?.type, "reasoning");
      assert.equal(String(reasoning?.text).length, 8000);
      assert.equal(reasoning?.truncated, true);
      assert.equal(reasoning?.fullLength, 9000);
      // patch の files は合計 2000 字（先頭2要素、超過ぶんだけ残す）
      const patch = parts.get("p10");
      assert.equal(patch?.type, "patch");
      const files = (patch?.files ?? []) as string[];
      assert.equal(files.length, 2);
      assert.equal(
        files.reduce((n, f) => n + f.length, 0),
        2000,
      );
      assert.equal(files.join("").includes("FILETAIL"), false);
      // subtask の prompt は text と同じ caps
      const subtask = parts.get("p11");
      assert.equal(subtask?.type, "subtask");
      assert.equal(subtask?.command, "review");
      assert.equal(String(subtask?.prompt).length, 8000);
      assert.equal(subtask?.promptTruncated, true);
      assert.equal(subtask?.promptFullLength, 9000);
      // compaction / step-start / step-finish
      assert.equal(parts.get("p12")?.auto, true);
      assert.deepEqual(parts.get("p13")?.raw, { reason: "maxsteps" });
      assert.deepEqual(parts.get("p14")?.raw, { reason: null });
      // 未知型は else 分岐で JSON を 2000 字に切って rawText に持つ
      const mystery = parts.get("p15");
      assert.equal(mystery?.type, "mystery");
      assert.equal(String(mystery?.rawText).length, 2000);
      assert.ok(String(mystery?.rawText).startsWith('{"type":"mystery"'));
    } finally {
      db.close();
    }
  });
});

describe("openDb / defaultDbPath", () => {
  it("opens the database read-only so every write fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv-readonly-"));
    const file = path.join(dir, "opencode.db");
    try {
      // 検証用の書き込み可能 DB を先に用意する（実 DB には触らない）
      const writable = new DatabaseSync(file);
      writable.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
      writable.prepare("INSERT INTO session (id) VALUES ('a')").run();
      writable.close();

      const db = openDb(file);
      try {
        assert.throws(() => {
          db.prepare("INSERT INTO session (id) VALUES ('b')").run();
        }, /readonly/i);
        assert.throws(() => db.exec("DELETE FROM session"), /readonly/i);
        // 読み取りはできる（DB が壊れているのではなく権限の問題であること）
        const count = db.prepare("SELECT COUNT(*) AS c FROM session").get();
        assert.equal(count?.c, 1);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers OPENCODE_DB over the default XDG path", () => {
    const previous = process.env.OPENCODE_DB;
    delete process.env.OPENCODE_DB;
    try {
      const home = os.homedir();
      const xdg = path.join(home, ".local", "share", "opencode");
      assert.equal(defaultDbPath(), path.join(xdg, "opencode.db"));
      const custom = path.join(os.tmpdir(), "custom-opencode.db");
      process.env.OPENCODE_DB = custom;
      assert.equal(defaultDbPath(), custom);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previous;
    }
  });
});
