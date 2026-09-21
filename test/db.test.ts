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
});
