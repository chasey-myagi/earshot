import assert from "node:assert/strict";
import { test } from "node:test";
import { mapMediaStatus, screenNeedsAllow } from "./screen-status.ts";

test("denied screen still needs an allow action", () => {
  assert.equal(screenNeedsAllow("denied"), true);
  assert.equal(screenNeedsAllow("undetermined"), true);
  assert.equal(screenNeedsAllow("granted"), false);
});

test("mapMediaStatus maps Electron media statuses", () => {
  assert.equal(mapMediaStatus("granted"), "granted");
  assert.equal(mapMediaStatus("authorized"), "granted");
  assert.equal(mapMediaStatus("not determined"), "undetermined");
  assert.equal(mapMediaStatus("denied"), "denied");
  assert.equal(mapMediaStatus("restricted"), "denied");
  assert.equal(mapMediaStatus("not-determined"), "undetermined");
  assert.equal(mapMediaStatus("unknown"), "undetermined");
  assert.equal(mapMediaStatus("prompt"), "undetermined");
});
