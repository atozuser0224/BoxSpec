import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { resolveTrustedRendererUrl } = await import("../../apps/desktop/src/main/renderer-url.ts");
const { validateRecoveryInput } = await import("../../apps/desktop/src/main/validation.ts");
const bundled = join(tmpdir(), "BoxSpec", "renderer", "index.html");

test("SEC-002: packaged app ignores attacker-controlled loopback renderer URL", () => {
  const resolved = resolveTrustedRendererUrl({
    packaged: true,
    developmentUrl: "http://127.0.0.1:43123/attacker",
    rendererHtmlPath: bundled,
  });
  assert.equal(resolved.protocol, "file:");
  assert.equal(resolved.pathname.endsWith("/renderer/index.html"), true);
  assert.equal(resolved.href.includes("43123"), false);
});

test("development renderer permits only explicit 127.0.0.1 HTTP", () => {
  assert.equal(resolveTrustedRendererUrl({
    packaged: false,
    developmentUrl: "http://127.0.0.1:5173",
    rendererHtmlPath: bundled,
  }).origin, "http://127.0.0.1:5173");

  for (const developmentUrl of [
    "https://127.0.0.1:5173",
    "http://localhost:5173",
    "http://0.0.0.0:5173",
    "file:///tmp/attacker.html",
  ]) {
    assert.throws(() => resolveTrustedRendererUrl({ packaged: false, developmentUrl, rendererHtmlPath: bundled }));
  }
});

test("SEC-040: recovery IPC rejects malformed nested authority fields", () => {
  const valid = {
    projectId: "prj_one",
    recovery: {
      transactionId: "txn_one",
      recoveryNonce: "nonce_one",
      strategy: "finish-after",
      unknownPathDecisions: [{ path: "src/a.ts", action: "preserve-current" }],
    },
  };
  assert.equal(validateRecoveryInput(valid).ok, true);
  for (const input of [
    { ...valid, recovery: { ...valid.recovery, strategy: "not-a-strategy" } },
    { ...valid, recovery: { ...valid.recovery, extra: true } },
    { ...valid, recovery: { ...valid.recovery, unknownPathDecisions: [{ path: "src/a.ts", action: "overwrite" }] } },
    { ...valid, recovery: { ...valid.recovery, unknownPathDecisions: [{ path: "src/a.ts", action: "finish-after" }, { path: "src/a.ts", action: "finish-after" }] } },
    { ...valid, recovery: { ...valid.recovery, unknownPathDecisions: "src/a.ts" } },
  ]) {
    assert.deepEqual(validateRecoveryInput(input).ok, false);
  }
});

test("SEC-015: packaged renderer CSP has no development loopback egress", async () => {
  const html = await readFile(new URL("../../apps/desktop/dist/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /connect-src 'self';/u);
  assert.doesNotMatch(html, /127\.0\.0\.1|localhost|ws:\/\//iu);
});
