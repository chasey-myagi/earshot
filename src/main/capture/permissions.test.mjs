import assert from "node:assert/strict";
import { test } from "node:test";
import { micRequestResult, startBlockers } from "./permissions.ts";

const granted = { microphone: "granted", screen: "granted" };

test("startBlockers allows recording when key and permissions are ready", () => {
  assert.equal(
    startBlockers({
      busy: false,
      hasApiKey: true,
      permissions: granted,
    }),
    null,
  );
});

test("startBlockers blocks when already recording", () => {
  assert.deepEqual(
    startBlockers({
      busy: true,
      hasApiKey: true,
      permissions: granted,
    }),
    { ok: false, error: "正在录音", code: "busy" },
  );
});

test("startBlockers blocks when there is no API key", () => {
  assert.deepEqual(
    startBlockers({
      busy: false,
      hasApiKey: false,
      permissions: granted,
    }),
    { ok: false, error: "没有密钥不能开始", code: "no_key" },
  );
});

test("startBlockers blocks when microphone is not granted", () => {
  assert.deepEqual(
    startBlockers({
      busy: false,
      hasApiKey: true,
      permissions: { microphone: "denied", screen: "granted" },
    }),
    { ok: false, error: "需要麦克风权限", code: "no_mic" },
  );
});

test("startBlockers blocks when screen recording is not granted", () => {
  assert.deepEqual(
    startBlockers({
      busy: false,
      hasApiKey: true,
      permissions: { microphone: "granted", screen: "undetermined" },
    }),
    { ok: false, error: "需要屏幕录制权限", code: "no_screen" },
  );
});

test("micRequestResult is ok when the user grants the microphone", () => {
  assert.deepEqual(micRequestResult(true), { ok: true });
});

test("micRequestResult asks for microphone permission when denied", () => {
  assert.deepEqual(micRequestResult(false), { ok: false, error: "需要麦克风权限", code: "no_mic" });
});
