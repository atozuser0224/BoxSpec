import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const core = await import("../../packages/core/dist/index.js");
const dashboard = JSON.parse(await readFile(new URL("../../examples/dashboard.contract.json", import.meta.url), "utf8"));

function clone(value) {
  return structuredClone(value);
}

function expectPolicyViolation(action) {
  assert.throws(action, (error) => error?.code === "POLICY_VIOLATION");
}

test("SEC-001: agent replacement cannot weaken top-level policy or verification", () => {
  const before = core.parseLayoutContract(clone(dashboard));
  const after = clone(before);
  after.revision += 1;
  after.defaultPolicy.layout = "free";
  after.assertions = [];
  after.verification.requiredChecks = ["schema"];

  expectPolicyViolation(() => core.assertAgentContractChangeAllowed(
    before,
    core.parseLayoutContract(after),
    { kind: "agent", id: "hostile-agent" },
  ));
});

test("hard sidebar width cannot be overridden from 260 to 320", () => {
  const contract = core.parseLayoutContract(clone(dashboard));
  expectPolicyViolation(() => core.applyLayoutOverrides(
    contract,
    [{ nodeId: "sidebar", path: "/layout/width/value", value: 320 }],
    { kind: "agent", id: "hostile-agent" },
  ));
  assert.equal(contract.nodes.find((node) => node.id === "sidebar").layout.width.value, 260);
});

test("agent replacement cannot remove locks or change non-layout node fields", () => {
  const before = core.parseLayoutContract(clone(dashboard));
  for (const mutate of [
    (after) => { after.nodes.find((node) => node.id === "sidebar").locks = []; },
    (after) => { after.nodes.find((node) => node.id === "sidebar").visible = false; },
    (after) => {
      const sidebar = after.nodes.find((node) => node.id === "sidebar");
      sidebar.parentId = "main";
      sidebar.order = 2;
    },
  ]) {
    const after = clone(before);
    after.revision += 1;
    mutate(after);
    expectPolicyViolation(() => core.assertAgentContractChangeAllowed(
      before,
      core.parseLayoutContract(after),
      { kind: "agent", id: "hostile-agent" },
    ));
  }
});

test("free ancestor layout cannot move a hard-constrained descendant", () => {
  const input = clone(dashboard);
  input.nodes.find((node) => node.id === "body").locks.push({ path: "/layout/gap", policy: "free" });
  const contract = core.parseLayoutContract(input);
  expectPolicyViolation(() => core.applyLayoutOverrides(
    contract,
    [{ nodeId: "body", path: "/layout/gap", value: 10 }],
    { kind: "agent", id: "hostile-agent" },
  ));
});

test("SEC-039: unsupported future documents preserve exact unknown JSON numbers", () => {
  const input = {
    schemaVersion: "2.0.0",
    future: {
      precise: 0.123456789,
      tiny: 0.000000123456789,
      nested: [{ decomposed: "e\u0301" }],
    },
  };
  const inspected = core.inspectContractDocument(input);
  assert.equal(inspected.status, "read-only");
  assert.equal(inspected.document.future.precise, 0.123456789);
  assert.equal(inspected.document.future.tiny, 0.000000123456789);
  assert.equal(inspected.document.future.nested[0].decomposed, "e\u0301");
  assert.throws(
    () => core.migrateContractDocument(input, []),
    (error) => error?.code === "READ_ONLY",
  );
});
