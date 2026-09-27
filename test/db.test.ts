import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeLike,
  getSessionDetail,
  getStats,
  getTimeline,
  listSessions,
  searchParts,
} from "../src/db.ts";
import { fixture } from "./fixture.ts";

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
  it("orders by id as a tiebreaker for equal timestamps", () => {
    const db = fixture();
    try {
      // s1/s2/s3 は time_created が同値なので id 降順で決定的に並ぶ
      const { sessions } = listSessions(db, { limit: 3, sort: "created" });
      assert.deepEqual(
        sessions.map((s) => String(s.id)),
        ["s3", "s2", "s1"],
      );
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
      // 実 DB で観測された巨大 state.title（26,065 文字）を模して 3000 文字を INSERT
      const longTitle = `titlecapstart ${"x".repeat(3000)}`;
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "tcap",
        "m4",
        "s3",
        90,
        90,
        JSON.stringify({
          type: "tool",
          tool: "read",
          state: {
            title: longTitle,
            input: { filePath: "/a.ts" },
            output: "ok",
          },
        }),
      );

      const detail = getSessionDetail(db, "s3") as unknown as {
        messages: { parts: { id: string; title?: unknown }[] }[];
      } | null;
      assert.ok(detail);
      const capPart = detail.messages
        .flatMap((m) => m.parts)
        .find((p) => p.id === "tcap");
      assert.ok(capPart);
      const title = typeof capPart.title === "string" ? capPart.title : "";
      assert.equal(title.length, 1000);

      // 先頭付近の語で検索しないとスニペット源（caps 済み title）から消える
      const { total, hits } = searchParts(db, { q: "titlecapstart" });
      assert.equal(total, 1);
      const hit = hits.find((h) => String(h.part_id) === "tcap");
      assert.ok(hit);
      const hitTitle = typeof hit.title === "string" ? hit.title : "";
      assert.equal(hitTitle.length, 1000);
      assert.match(String(hit.snippet), /titlecapstart/);
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
      assert.ok(total >= 1);
      assert.ok(
        hits.some(
          (h) =>
            typeof h.snippet === "string" &&
            (h.snippet as string).includes("alpha"),
        ),
      );
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
});

describe("getTimeline", () => {
  it("aggregates sessions, messages and titles by local day", () => {
    const db = fixture();
    try {
      const days = getTimeline(db);
      assert.equal(days.length, 1);
      const day = days[0];
      assert.equal(day?.sessions, 3);
      assert.equal(day?.messages, 4);
      assert.deepEqual(day?.titles.slice().sort(), [
        "first",
        "second",
        "third",
      ]);
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
      const dayStr = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;

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
  it("reports totals, per-project sessions and tool usage", () => {
    const db = fixture();
    try {
      const stats = getStats(db);
      assert.equal(stats.sessionCount, 3);
      assert.equal(stats.messageCount, 4);
      assert.equal(stats.partCount, 9);
      assert.equal(stats.perProject[0]?.sessions, 3);
      const tools = new Map(stats.toolUsage.map((t) => [String(t.tool), t.c]));
      assert.equal(tools.get("read"), 1);
      assert.equal(tools.get("bash"), 1);
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
