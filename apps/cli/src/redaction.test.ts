import assert from "node:assert/strict";
import test from "node:test";
import { redactString, redactValue } from "./redaction.js";

test("redactValue removes secret-key values at every depth", () => {
  const input = {
    token: "top-secret",
    nested: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz", safe: "kept" },
    rows: [{ authorization: "Bearer abc.def.ghi" }],
  };
  const output = redactValue(input, { USERPROFILE: "C:\\Users\\diagnostic-user" });
  assert.deepEqual(output, {
    token: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", safe: "kept" },
    rows: [{ authorization: "[REDACTED]" }],
  });
});

test("redactString scrubs homes, URL credentials, bearer values, and token-shaped text", () => {
  const input = "C:\\Users\\diagnostic-user\\BoxSpec https://alice:hunter2@example.test Authorization: Bearer abc.def.ghi ghp_abcdefghijklmnopqrstuvwxyz";
  const output = redactString(input, { USERPROFILE: "C:\\Users\\diagnostic-user" });
  assert.match(output, /<home>[\\/]BoxSpec/);
  assert.doesNotMatch(output, /diagnostic-user|alice|hunter2|abc\.def\.ghi|ghp_/);
  assert.match(output, /https:\/\/\[REDACTED\]@example\.test/);
  assert.match(output, /Authorization=\[REDACTED\]/);
});

test("redaction handles cycles without leaking nested values", () => {
  const input: Record<string, unknown> = { password: "never-print" };
  input.self = input;
  assert.deepEqual(redactValue(input), { password: "[REDACTED]", self: "[CIRCULAR]" });
});
