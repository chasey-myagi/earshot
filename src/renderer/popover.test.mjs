import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorPopover } from "./popover.ts";

test("anchorPopover opens below anchor by default", () => {
  const point = anchorPopover(
    { left: 100, top: 80, right: 160, bottom: 100 },
    { width: 228, height: 180 },
    { width: 800, height: 600 },
  );
  assert.equal(point.top, 108);
  assert.equal(point.left, 100);
});

test("anchorPopover flips above when below overflows", () => {
  const point = anchorPopover(
    { left: 100, top: 500, right: 160, bottom: 520 },
    { width: 228, height: 180 },
    { width: 800, height: 600 },
  );
  assert.equal(point.top, 312);
});

test("anchorPopover clamps top to pad when flipping above still overflows", () => {
  const point = anchorPopover(
    { left: 100, top: 10, right: 160, bottom: 30 },
    { width: 228, height: 400 },
    { width: 800, height: 200 },
  );
  assert.equal(point.top, 8);
});

test("anchorPopover clamps horizontal overflow", () => {
  const point = anchorPopover(
    { left: 700, top: 100, right: 760, bottom: 120 },
    { width: 228, height: 120 },
    { width: 800, height: 600 },
  );
  assert.equal(point.left, 564);
});
