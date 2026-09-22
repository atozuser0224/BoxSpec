import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shared = await import("../../packages/shared/dist/runtime.js");
const catalog = JSON.parse(await readFile(new URL("../../packages/bridge/contracts/mcp-tools.json", import.meta.url), "utf8"));

const forbidden = ["approve", "unlock", "apply_to_main", "run_shell", "delete_project", "read_secret"];

test("MCP publishes exactly the shared safe-tool allowlist", () => {
  const advertised = catalog.tools.map((tool) => tool.name);
  assert.deepEqual([...advertised].sort(), [...shared.SAFE_MCP_TOOL_NAMES].sort());
  assert.equal(new Set(advertised).size, advertised.length);
});

test("MCP has no approval, apply, unlock, shell, deletion, or secret capability", () => {
  const names = new Set(catalog.tools.map((tool) => tool.name));
  for (const name of forbidden) assert.equal(names.has(name), false, `forbidden tool exposed: ${name}`);
  assert.equal([...names].some((name) => /approve|apply_to_main|run_shell|read_secret|unlock/u.test(name)), false);
});

test("review request queues review and cannot claim approval/application", () => {
  const review = catalog.tools.find((tool) => tool.name === "boxspec_request_review");
  assert.ok(review);
  const success = review.outputSchema.oneOf.find((branch) => branch.properties?.ok?.const === true);
  assert.equal(success.properties.data.properties.state.const, "PENDING_APPROVAL");
  assert.equal(JSON.stringify(review).includes("APPLIED"), false);
});

