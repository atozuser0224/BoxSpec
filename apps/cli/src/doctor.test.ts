import assert from "node:assert/strict";
import test from "node:test";
import { aggregateStatus, doctorExitCode } from "./doctor.js";
import type { DoctorReport } from "./types.js";

test("unknown, unavailable, and not-run never aggregate to PASS", () => {
  assert.equal(aggregateStatus(["PASS", "UNKNOWN"]), "DEGRADED");
  assert.equal(aggregateStatus(["PASS", "UNAVAILABLE"]), "DEGRADED");
  assert.equal(aggregateStatus(["PASS", "NOT_RUN"]), "DEGRADED");
  assert.equal(aggregateStatus(["PASS", "FAIL"]), "FAIL");
  assert.equal(aggregateStatus(["PASS", "PASS"]), "PASS");
});

test("degraded evidence uses exit 2 and an active failure uses exit 1", () => {
  const report = minimalReport("DEGRADED", "UNKNOWN");
  assert.equal(doctorExitCode(report), 2);
  assert.equal(doctorExitCode(minimalReport("FAIL", "FAIL")), 1);
  assert.equal(doctorExitCode(minimalReport("PASS", "PASS")), 0);
});

function minimalReport(overallStatus: DoctorReport["overallStatus"], variableStatus: DoctorReport["runtime"]["status"]): DoctorReport {
  const pass = { status: "PASS" as const, summary: "ok", data: {} };
  const agent = { status: "PASS" as const, summary: "ok", data: { executable: "tool", available: true } };
  const config = { status: "PASS" as const, summary: "ok", data: { written: true, actualClientCall: "not-run" as const } };
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-09-22T00:00:00.000Z",
    overallStatus,
    redaction: { applied: true, policyVersion: "1.0.0", replacement: "[REDACTED]" },
    installation: { status: "PASS", summary: "ok", data: { cliVersion: "0.1.0", nodeVersion: "v24.19.0", platform: "win32", architecture: "x64", installPath: "<home>\\BoxSpec" } },
    runtime: { status: variableStatus, summary: "runtime", data: { moduleResolved: variableStatus === "PASS", factoryExported: variableStatus === "PASS" } },
    bridge: { status: "PASS", summary: "ok", data: { commandConfigured: true, processStarted: true, handshakeSucceeded: true, toolsListed: true, capabilityCallSucceeded: true } },
    core: { status: "PASS", summary: "ok", data: { actualMcpCall: true, appRunning: true } },
    grants: { status: "PASS", summary: "ok", data: { state: "active", observedThrough: "capability-call" } },
    browser: { status: "PASS", summary: "ok", data: { executablePresent: true, launchSucceeded: true } },
    git: { status: "PASS", summary: "ok", data: { available: true, currentDirectoryIsWorktree: false } },
    adapter: { status: "PASS", summary: "ok", data: { target: "web-react", capabilities: [] } },
    agents: { codex: agent, "claude-code": agent, opencode: agent },
    clientConfiguration: { codex: config, "claude-code": config, opencode: config },
  };
}
