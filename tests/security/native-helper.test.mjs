import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NATIVE_SAFE_FS_MANIFEST } from "../../packages/shared/dist/native-tools.js";

test("canonical Windows helper closes path races and recovery boundaries", { skip: process.platform !== "win32", timeout: 60_000 }, () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const script = resolve(repositoryRoot, "crates/boxspec-safe-fs/tests/windows-integration.ps1");
  const scriptSource = readFileSync(script, "utf8");
  for (const requiredScenario of [
    "source drift is rejected",
    "hard-linked target is rejected",
    "junction ancestor is rejected",
    "root substitution is rejected",
    "ensure_directory rejects a junction collision",
    "concurrent creators both validate the final chain",
    "raced ensure never creates through substituted ancestor",
    "concurrent ancestor swap does not modify outside sentinel",
    "no-op recovery cleans both exact artifacts",
  ]) {
    assert.match(scriptSource, new RegExp(requiredScenario.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  const output = execFileSync("pwsh", ["-NoProfile", "-File", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 55_000,
  });
  const evidence = JSON.parse(output);
  assert.equal(evidence.passed, true);
  assert.ok(Number.isInteger(evidence.assertions) && evidence.assertions > 0);
  assert.equal(evidence.executableSha256, NATIVE_SAFE_FS_MANIFEST.sha256);
  assert.equal(evidence.raceAttackerMoved, false);
  assert.equal(evidence.raceHelperOk, true);
});
