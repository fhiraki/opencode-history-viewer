import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveNavIndex } from "../src/shared/nav.ts";

describe("resolveNavIndex", () => {
  it("returns 0 when there are no anchors", () => {
    assert.equal(resolveNavIndex([], 80), 0);
  });
  it("stays on the first anchor above the header area", () => {
    assert.equal(resolveNavIndex([150, 400, 900], 80), 0);
  });
  it("picks the last anchor above the threshold line", () => {
    assert.equal(resolveNavIndex([12, 50, 400], 80), 1);
    assert.equal(resolveNavIndex([-200, -50, 10], 80), 2);
  });
  it("pins to the last anchor once scrolled past the end", () => {
    assert.equal(resolveNavIndex([-900, -400, -10], 80), 2);
  });
  it("treats the threshold as inclusive", () => {
    assert.equal(resolveNavIndex([10, 80, 200], 80), 1);
    assert.equal(resolveNavIndex([10, 81, 200], 80), 0);
  });
});
