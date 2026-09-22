import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutable } from "./process.js";

test("a missing executable is reported as unavailable", async () => {
  const missing = await resolveExecutable("boxspec-tool-that-does-not-exist-9f31e6", {
    PATH: process.platform === "win32" ? "C:\\definitely-missing" : "/definitely-missing",
    PATHEXT: ".EXE;.CMD",
  });
  assert.equal(missing, null);
});
