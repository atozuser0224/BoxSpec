import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LayoutContract } from "@boxspec/shared/contracts";
import { hashContract, validateLayoutContract } from "@boxspec/core";
import { evaluateLayoutAssertions } from "./assertions.js";
import { runBrowserVerification, type BrowserEvidenceWriter } from "./browser.js";
import {
  assertCandidateIntegrity,
  assertEvidenceOutsideCandidate,
  createId,
  hashCanonical,
  resolveInside,
  sha256Bytes,
} from "./hash.js";
import { evaluatePolicy } from "./policy.js";
import { runExplicitCommand } from "./process.js";
import { verifyTrustedAssetClosures } from "./packaged-profile.js";
import type {
  CheckStatus,
  EvidenceArtifact,
  RenderMeasurement,
  SpatialComparison,
  VerificationCheck,
  VerificationCheckKind,
  VerificationReport,
  VerificationStatus,
  VerifyCandidateInput,
  Violation,
} from "./types.js";

const SUPPORTED_REQUIRED_CHECKS = new Set<VerificationCheckKind>([
  "schema",
  "policy",
  "layout",
  "types",
  "build",
  "interactions",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class EvidenceWriter implements BrowserEvidenceWriter {
  readonly artifacts: EvidenceArtifact[] = [];

  constructor(
    private readonly evidenceRoot: string,
    private readonly reportId: string,
    readonly reportDirectory: string,
  ) {}

  private async register(
    kind: EvidenceArtifact["kind"],
    absolutePath: string,
    mediaType: string,
    viewportId?: string,
    fixtureId?: string,
  ): Promise<EvidenceArtifact> {
    const bytes = await readFile(absolutePath);
    const relativePath = relative(this.evidenceRoot, absolutePath).replaceAll("\\", "/");
    const artifact: EvidenceArtifact = {
      artifactId: createId("artifact"),
      kind,
      relativePath,
      sha256: sha256Bytes(bytes),
      mediaType,
      ...(viewportId ? { viewportId } : {}),
      ...(fixtureId ? { fixtureId } : {}),
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async text(kind: "build-log" | "interaction-log", name: string, value: string): Promise<EvidenceArtifact> {
    const path = resolveInside(this.reportDirectory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, "utf8");
    return this.register(kind, path, "text/plain; charset=utf-8");
  }

  async json(
    kind: "metrics" | "interaction-log",
    name: string,
    value: unknown,
    viewportId?: string,
    fixtureId?: string,
  ): Promise<EvidenceArtifact> {
    const path = resolveInside(this.reportDirectory, `artifacts/${name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return this.register(kind, path, "application/json", viewportId, fixtureId);
  }

  async screenshot(page: Parameters<BrowserEvidenceWriter["screenshot"]>[0], viewportId: string, fixtureId: string): Promise<EvidenceArtifact> {
    const path = resolveInside(this.reportDirectory, `artifacts/${viewportId}-${fixtureId}.png`);
    await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide" });
    return this.register("screenshot", path, "image/png", viewportId, fixtureId);
  }

  async writeReport(report: VerificationReport): Promise<string> {
    const path = join(this.reportDirectory, "report.json");
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return path;
  }
}

function check(
  kind: VerificationCheckKind,
  status: CheckStatus,
  message: string,
  extra: Partial<Pick<VerificationCheck, "durationMs" | "exitCode">> = {},
): VerificationCheck {
  return { id: kind, kind, status, blocking: true, message, ...extra };
}

function notRunChecks(kinds: readonly VerificationCheckKind[], reason: string): VerificationCheck[] {
  return kinds.map((kind) => check(kind, "NOT_RUN", reason));
}

function aggregateStatus(checks: readonly VerificationCheck[], required: readonly string[], stale: boolean): VerificationStatus {
  if (stale) return "STALE";
  const requiredSet = new Set(required);
  const requiredChecks = checks.filter((item) => requiredSet.has(item.kind));
  const blockingChecks = checks.filter((item) => item.blocking);
  const complete = required.length === requiredSet.size && [...requiredSet].every((kind) => requiredChecks.filter((item) => item.kind === kind).length === 1);
  if (blockingChecks.some((item) => item.status === "ERROR")) return "ERROR";
  if (blockingChecks.some((item) => item.status === "FAIL")) return "FAIL";
  if (!complete) return "UNVERIFIED";
  if (requiredChecks.some((item) => item.status !== "PASS")) return "UNVERIFIED";
  const integrity = checks.find((item) => item.kind === "integrity");
  return integrity?.status === "PASS" ? "PASS" : "UNVERIFIED";
}

function comparisonsFor(
  measurements: readonly RenderMeasurement[],
  baseline: readonly RenderMeasurement[] | undefined,
): SpatialComparison[] {
  if (!baseline) return [];
  const output: SpatialComparison[] = [];
  for (const afterMeasurement of measurements) {
    const beforeMeasurement = baseline.find(
      (item) => item.viewportId === afterMeasurement.viewportId && item.fixtureId === afterMeasurement.fixtureId,
    );
    if (!beforeMeasurement) continue;
    for (const [nodeId, after] of Object.entries(afterMeasurement.nodes)) {
      const before = beforeMeasurement.nodes[nodeId];
      if (!before) continue;
      output.push({
        nodeId,
        viewportId: afterMeasurement.viewportId,
        fixtureId: afterMeasurement.fixtureId,
        before,
        after,
        delta: {
          left: after.left - before.left,
          top: after.top - before.top,
          width: after.width - before.width,
          height: after.height - before.height,
        },
      });
    }
  }
  return output;
}

function identityOf(input: VerifyCandidateInput) {
  const candidate = input.candidate;
  return {
    projectId: candidate.projectId,
    taskId: candidate.taskId,
    treeHash: candidate.treeHash,
    contractHash: candidate.baseContractHash,
    effectiveContractHash: candidate.effectiveContractHash,
    layoutOverridesHash: candidate.layoutOverridesHash,
    baseContractRevision: candidate.baseContractRevision,
    baseCommitHash: candidate.baseCommitHash,
    baseManifestHash: candidate.baseManifestHash,
    generatorVersion: candidate.generatorVersion,
    policyHash: candidate.policyHash,
    policyRevision: candidate.policyRevision,
    dependencyLockHash: candidate.dependencyLockHash,
    fixturesHash: candidate.fixturesHash,
    verificationProfileId: candidate.verificationProfileId,
    verificationProfileHash: candidate.verificationProfileHash,
  } as const;
}

export async function verifyCandidate(input: VerifyCandidateInput): Promise<VerificationReport> {
  const startedAt = new Date().toISOString();
  const reportId = createId("report");
  const checks: VerificationCheck[] = [];
  const violations: Violation[] = [];
  let measurements: RenderMeasurement[] = [];
  let stale = false;
  let requiredChecks: readonly string[] = ["schema", "policy", "layout", "types", "build", "interactions"];
  if (!isAbsolute(input.candidate.snapshotRoot)) throw new Error("candidate.snapshotRoot must be absolute");
  await assertEvidenceOutsideCandidate(input.candidate.snapshotRoot, input.evidenceRoot);
  await mkdir(input.evidenceRoot, { recursive: true });
  await assertEvidenceOutsideCandidate(input.candidate.snapshotRoot, input.evidenceRoot);
  const reportDirectory = resolve(input.evidenceRoot, reportId);
  await mkdir(reportDirectory, { recursive: false });
  const evidence = new EvidenceWriter(input.evidenceRoot, reportId, reportDirectory);
  const outputDirectory = join(reportDirectory, input.profile.outputDirectoryName ?? "build");

  try {
    await Promise.all([assertCandidateIntegrity(input.candidate), verifyTrustedAssetClosures(input.profile.trustedAssetClosures)]);
    checks.push(check("integrity", "PASS", "Frozen candidate and trusted verification assets match at verification start"));
  } catch (error) {
    stale = true;
    checks.push(check("integrity", "FAIL", `Frozen candidate identity rejected: ${errorMessage(error)}`));
    violations.push({
      id: "integrity:start",
      checkId: "integrity",
      kind: "candidate-tamper",
      severity: "error",
      blocking: true,
      message: errorMessage(error),
    });
  }

  const validation = validateLayoutContract(input.contract);
  let contract: LayoutContract | undefined;
  if (!validation.ok) {
    checks.push(check("schema", "FAIL", `Contract validation failed with ${validation.diagnostics.length} diagnostic(s)`));
    for (const [index, diagnostic] of validation.diagnostics.entries()) {
      violations.push({
        id: `schema:${index}:${diagnostic.code}`,
        checkId: "schema",
        kind: diagnostic.code,
        severity: "error",
        blocking: true,
        message: `${diagnostic.path}: ${diagnostic.message}`,
      });
    }
  } else {
    contract = validation.contract;
    requiredChecks = contract.verification.requiredChecks;
    const duplicateRequired = requiredChecks.filter((kind, index) => requiredChecks.indexOf(kind) !== index);
    const computedContractHash = hashContract(contract);
    const identityErrors: string[] = [];
    if (computedContractHash !== input.candidate.effectiveContractHash) identityErrors.push("effective contract hash mismatch");
    if (hashCanonical(input.fixtures) !== input.candidate.fixturesHash) identityErrors.push("trusted fixture hash mismatch");
    if (hashCanonical(input.policy) !== input.candidate.policyHash) identityErrors.push("trusted policy hash mismatch");
    if (hashCanonical(input.profile) !== input.candidate.verificationProfileHash) identityErrors.push("verification profile hash mismatch");
    if (duplicateRequired.length > 0) identityErrors.push(`duplicate required checks: ${[...new Set(duplicateRequired)].join(", ")}`);
    if (identityErrors.length > 0) {
      stale = true;
      checks.push(check("schema", "FAIL", identityErrors.join("; ")));
      violations.push({
        id: "schema:trusted-identity",
        checkId: "schema",
        kind: "trusted-input-hash-mismatch",
        severity: "error",
        blocking: true,
        message: identityErrors.join("; "),
      });
    } else checks.push(check("schema", "PASS", "Schema, semantic rules, and trusted contract/profile/fixture hashes match"));
  }

  if (!stale && contract) {
    const policyViolations = evaluatePolicy(input.candidate, input.policy);
    violations.push(...policyViolations);
    checks.push(check("policy", policyViolations.length === 0 ? "PASS" : "FAIL", policyViolations.length === 0 ? "Candidate files satisfy trusted path and generator policy" : `${policyViolations.length} policy violation(s)`));
  } else checks.push(check("policy", "NOT_RUN", "Candidate identity or contract validation failed"));

  const policyPassed = checks.find((item) => item.kind === "policy")?.status === "PASS";
  if (!stale && contract && policyPassed) {
    try {
      const typeResult = await runExplicitCommand(input.profile.typecheck, input.candidate.snapshotRoot, outputDirectory, input.signal);
      await evidence.text("build-log", "typecheck.log", `${typeResult.stdout}\n${typeResult.stderr}`);
      checks.push(
        check(
          "types",
          typeResult.exitCode === 0 && !typeResult.timedOut && !typeResult.outputLimitExceeded ? "PASS" : typeResult.timedOut || typeResult.outputLimitExceeded ? "ERROR" : "FAIL",
          typeResult.timedOut ? "Typecheck timed out" : typeResult.outputLimitExceeded ? "Typecheck exceeded the trusted output limit" : `Typecheck exited with code ${typeResult.exitCode}`,
          { durationMs: typeResult.durationMs, exitCode: typeResult.exitCode },
        ),
      );
      if (typeResult.exitCode === 0 && !typeResult.timedOut && !typeResult.outputLimitExceeded) {
        try {
          const buildResult = await runExplicitCommand(input.profile.build, input.candidate.snapshotRoot, outputDirectory, input.signal);
          await evidence.text("build-log", "build.log", `${buildResult.stdout}\n${buildResult.stderr}`);
          checks.push(
            check(
              "build",
              buildResult.exitCode === 0 && !buildResult.timedOut && !buildResult.outputLimitExceeded ? "PASS" : buildResult.timedOut || buildResult.outputLimitExceeded ? "ERROR" : "FAIL",
              buildResult.timedOut ? "Production build timed out" : buildResult.outputLimitExceeded ? "Production build exceeded the trusted output limit" : `Production build exited with code ${buildResult.exitCode}`,
              { durationMs: buildResult.durationMs, exitCode: buildResult.exitCode },
            ),
          );
        } catch (error) {
          checks.push(check("build", "ERROR", `Production build could not start: ${errorMessage(error)}`));
          violations.push({ id: "build:error", checkId: "build", kind: "process-error", severity: "error", blocking: true, message: errorMessage(error) });
        }
      } else checks.push(check("build", "NOT_RUN", "Production build was not run after typecheck failure"));
    } catch (error) {
      checks.push(check("types", "ERROR", `Typecheck could not start: ${errorMessage(error)}`));
      checks.push(check("build", "NOT_RUN", "Production build was not run after typecheck process error"));
      violations.push({ id: "types:error", checkId: "types", kind: "process-error", severity: "error", blocking: true, message: errorMessage(error) });
    }
  } else checks.push(...notRunChecks(["types", "build"], "Candidate identity, contract, or policy check failed"));

  const buildPassed = checks.find((item) => item.kind === "build")?.status === "PASS";
  if (!stale && contract && buildPassed) {
    try {
      await verifyTrustedAssetClosures(input.profile.trustedAssetClosures);
      const browserResult = await runBrowserVerification({
        contract,
        fixtures: input.fixtures,
        outputDirectory,
        route: input.profile.route,
        fixtureQueryParameter: input.profile.fixtureQueryParameter ?? "fixture",
        interactions: input.profile.interactions,
        ...(input.profile.browserExecutablePath ? { executablePath: input.profile.browserExecutablePath } : {}),
        ...(input.profile.browserExecutableSha256 ? { executableSha256: input.profile.browserExecutableSha256 } : {}),
        evidence,
      });
      measurements = [...browserResult.measurements];
      violations.push(...browserResult.violations);
      const layoutViolations = evaluateLayoutAssertions(contract, measurements);
      violations.push(...layoutViolations);
      const blockingBrowserViolations = browserResult.violations.filter((item) => item.checkId === "layout" && item.blocking);
      const totalLayoutViolations = layoutViolations.length + blockingBrowserViolations.length;
      checks.push(check("layout", totalLayoutViolations === 0 ? "PASS" : "FAIL", totalLayoutViolations === 0 ? `${measurements.length} real browser render(s) satisfy layout assertions` : `${totalLayoutViolations} measured or browser-policy layout violation(s)`));
      const interactionStatus: CheckStatus =
        input.profile.interactions.length === 0
          ? "NOT_RUN"
          : browserResult.interactionPassed
            ? "PASS"
            : "FAIL";
      checks.push(check("interactions", interactionStatus, browserResult.interactionMessage));
    } catch (error) {
      checks.push(check("layout", "ERROR", `Browser verification failed: ${errorMessage(error)}`));
      checks.push(check("interactions", "NOT_RUN", "Interaction checks were not completed because browser verification failed"));
      violations.push({
        id: "browser:error",
        checkId: "layout",
        kind: "browser-error",
        severity: "error",
        blocking: true,
        message: errorMessage(error),
      });
    }
  } else checks.push(...notRunChecks(["layout", "interactions"], "Production build did not pass"));

  for (const required of new Set(requiredChecks)) {
    if (!SUPPORTED_REQUIRED_CHECKS.has(required as VerificationCheckKind)) {
      checks.push(check(required as VerificationCheckKind, "UNSUPPORTED", `Required check '${required}' is not supported by the P1 web verifier`));
    }
  }

  try {
    await Promise.all([assertCandidateIntegrity(input.candidate), verifyTrustedAssetClosures(input.profile.trustedAssetClosures)]);
  } catch (error) {
    stale = true;
    const integrityIndex = checks.findIndex((item) => item.kind === "integrity");
    checks[integrityIndex] = check("integrity", "FAIL", `Candidate changed during verification: ${errorMessage(error)}`);
    violations.push({
      id: "integrity:end",
      checkId: "integrity",
      kind: "candidate-tamper",
      severity: "error",
      blocking: true,
      message: errorMessage(error),
    });
  }

  const completedAt = new Date().toISOString();
  const comparisons = comparisonsFor(measurements, input.baselineMeasurements);
  const status = aggregateStatus(checks, requiredChecks, stale);
  const digestPayload = {
    reportId,
    candidateId: input.candidate.candidateId,
    status,
    identity: identityOf(input),
    checks,
    violations,
    measurements,
    comparisons,
    artifacts: evidence.artifacts,
    startedAt,
    completedAt,
  };
  const report: VerificationReport = { ...digestPayload, evidenceDigest: hashCanonical(digestPayload) };
  await evidence.writeReport(report);
  return report;
}
