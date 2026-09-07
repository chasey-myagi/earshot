import assert from "node:assert/strict";
import { test } from "node:test";
import { captureScrollAnchor, restoreScrollTop } from "./scroll.ts";

test("appending and inserting turns preserves the same visible sentence instead of jumping to the bottom", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, timeMs: i * 1000, top: i * 100, height: 100 }));
  const anchor = captureScrollAnchor(rows, 225, 1200, 300, 12);
  assert.equal(anchor.following, false);
  const updated = rows.map(row => ({ ...row, top: row.top + 80 }));
  assert.equal(restoreScrollTop(anchor, updated, 1580, 300), 305);
  assert.equal(anchor.confirmedCount, 12);
});

test("refinement replacing ids restores the sentence at the same audio time; bottom followers stay at bottom", () => {
  const old = [{ id: "live-a", timeMs: 1000, top: 0, height: 100 },
    { id: "live-b", timeMs: 5000, top: 100, height: 100 }];
  const anchor = captureScrollAnchor(old, 120, 1000, 300, 12);
  const refined = [{ id: "ref-1", timeMs: 900, top: 0, height: 160 },
    { id: "ref-2", timeMs: 4800, top: 160, height: 150 },
    { id: "ref-3", timeMs: 7000, top: 310, height: 100 }];
  assert.equal(restoreScrollTop(anchor, refined, 1100, 300), 180);
  assert.equal(restoreScrollTop({ ...anchor, following: true }, refined, 1100, 300), 800);
});

test("empty and short documents, threshold, missing anchors and shorter replacements stay within scroll bounds", () => {
  assert.equal(captureScrollAnchor([], 0, 0, 300, 0).following, true);
  const row = { id: "a", timeMs: 1000, top: 0, height: 100 };
  const short = captureScrollAnchor([row], 0, 100, 300, 1);
  assert.equal(short.following, true);
  assert.equal(restoreScrollTop(short, [row], 100, 300), 0);
  assert.equal(captureScrollAnchor([row], 652, 1000, 300, 1).following, true);
  assert.equal(captureScrollAnchor([row], 651, 1000, 300, 1).following, false);
  const anchor = { id: "old", timeMs: 500, offset: 80, top: 200, following: false, confirmedCount: 1 };
  const rows = [{ ...row, top: 20, height: 30 }, { id: "b", timeMs: 2000, top: 50, height: 100 }];
  assert.equal(restoreScrollTop(anchor, rows, 500, 100), 49);
  assert.equal(restoreScrollTop({ ...anchor, timeMs: 3000 }, rows, 500, 100), 130);
  assert.equal(restoreScrollTop({ ...anchor, id: "a" }, rows, 500, 100), 49);
  assert.equal(restoreScrollTop(anchor, [], 0, 300), 0);
  assert.equal(restoreScrollTop({ ...anchor, timeMs: 3000 }, rows, 120, 100), 20);
});
