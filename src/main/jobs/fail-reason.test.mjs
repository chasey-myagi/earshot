import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobFailure } from "./fail-reason.ts";

test("classifyJobFailure maps auth errors to 密钥不对", () => {
  assert.equal(classifyJobFailure(new Error("HTTP 401 Unauthorized")), "密钥不对");
  assert.equal(classifyJobFailure(new Error("403 forbidden")), "密钥不对");
});

test("classifyJobFailure maps network and timeout", () => {
  assert.equal(classifyJobFailure(new Error("fetch failed ECONNREFUSED")), "网络不通");
  assert.equal(classifyJobFailure(new Error("request timed out")), "转写超时");
});

test("classifyJobFailure strips technical english", () => {
  const reason = classifyJobFailure(new Error("TypeError: Cannot read properties of undefined"));
  assert.equal(reason.includes("TypeError"), false);
  assert.ok(reason.length <= 40);
});
