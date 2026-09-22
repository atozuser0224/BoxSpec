import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashContract, validateLayoutContract } from "@boxspec/core";
import {
  hashCandidateFileEntries,
  inspectCandidateFiles,
  verifyCandidate,
  type FrozenCandidateDescriptor,
  type VerificationPolicy,
  type VerificationProfile,
  type VerifyCandidateInput,
} from "../src/index.js";
import { hashCanonical, sha256Bytes } from "../src/hash.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const sampleRoot = join(repositoryRoot, "samples/react-dashboard");
const durableEvidenceRoot = join(repositoryRoot, `packages/verifier/evidence/sample-run/run-${process.pid}`);
const requireFromSample = createRequire(join(sampleRoot, "package.json"));

const fixtures = Object.fromEntries(
  await Promise.all(
    ["populated", "empty", "loading", "error", "long-text"].map(async (id) => [
      id,
      JSON.parse(await readFile(join(repositoryRoot, `examples/fixtures/${id}.json`), "utf8")) as unknown,
    ]),
  ),
);
const rawContract: unknown = JSON.parse(await readFile(join(repositoryRoot, "examples/dashboard.contract.json"), "utf8"));
const contractResult = validateLayoutContract(rawContract);
if (!contractResult.ok) throw new Error(`Test contract invalid: ${JSON.stringify(contractResult.diagnostics)}`);
const contract = contractResult.contract;
const policy: VerificationPolicy = { allowedPaths: ["**"], protectedPaths: ["packages/verifier/**", ".boxspec/policies/**"] };

let temporaryRoot = "";
let nodeHash = "";
let profile: VerificationProfile;

async function freezeSample(name: string, sidebarWidth = 260, blockSearch = false): Promise<FrozenCandidateDescriptor> {
  const snapshotRoot = join(temporaryRoot, name);
  await mkdir(snapshotRoot, { recursive: true });
  for (const relativePath of ["package.json", "tsconfig.json", "vite.config.ts", "index.html", "src"]) {
    await cp(join(sampleRoot, relativePath), join(snapshotRoot, relativePath), { recursive: true });
  }
  const sourceLock = join(repositoryRoot, "pnpm-lock.yaml");
  await cp(sourceLock, join(snapshotRoot, "pnpm-lock.yaml"));
  if (sidebarWidth !== 260) {
    const cssPath = join(snapshotRoot, "src/styles.css");
    const css = await readFile(cssPath, "utf8");
    await writeFile(cssPath, css.replaceAll("260px", `${sidebarWidth}px`), "utf8");
  }
  if (blockSearch) {
    const cssPath = join(snapshotRoot, "src/styles.css");
    const css = await readFile(cssPath, "utf8");
    await writeFile(cssPath, `${css}\n.search::after { content: ""; position: absolute; inset: 0; z-index: 5; background: transparent; }\n`, "utf8");
  }
  const files = await inspectCandidateFiles(snapshotRoot);
  const dependencyLock = files.find((entry) => entry.relativePath === "pnpm-lock.yaml");
  if (!dependencyLock) throw new Error("Frozen test candidate is missing pnpm-lock.yaml");
  const treeHash = hashCandidateFileEntries(files);
  const contractHash = hashContract(contract);
  return {
    projectId: "prj_demo",
    taskId: `task-${name}`,
    candidateId: `candidate-${name}`,
    snapshotRoot,
    dependencyLockPath: "pnpm-lock.yaml",
    files,
    treeHash,
    baseContractHash: contractHash,
    effectiveContractHash: contractHash,
    layoutOverridesHash: hashCanonical([]),
    baseContractRevision: contract.revision,
    baseCommitHash: sha256Bytes("sample-base-commit"),
    baseManifestHash: treeHash,
    generatorVersion: "boxspec-react-shell/1.0.0",
    policyHash: hashCanonical(policy),
    policyRevision: 1,
    dependencyLockHash: dependencyLock.sha256,
    fixturesHash: hashCanonical(fixtures),
    verificationProfileId: "sample-web-p1",
    verificationProfileHash: hashCanonical(profile),
    changedPaths: files.map((file) => file.relativePath),
    changes: files.map((file) => ({ relativePath: file.relativePath, beforeSha256: null, afterSha256: file.sha256, beforeSize: null, afterSize: file.size })),
  };
}

function inputFor(candidate: FrozenCandidateDescriptor, evidenceRoot: string): VerifyCandidateInput {
  return { candidate, contract, policy, profile, fixtures, evidenceRoot };
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(sampleRoot, ".test-candidates-"));
  nodeHash = sha256Bytes(await readFile(process.execPath));
  const tscPath = resolve(dirname(requireFromSample.resolve("typescript")), "../bin/tsc");
  const vitePath = resolve(dirname(requireFromSample.resolve("vite")), "../../bin/vite.js");
  profile = {
    typecheck: {
      executable: process.execPath,
      executableSha256: nodeHash,
      args: [tscPath, "-p", ".", "--noEmit"],
      cwd: ".",
      timeoutMs: 60_000,
    },
    build: {
      executable: process.execPath,
      executableSha256: nodeHash,
      args: [vitePath, "build", "--outDir", "{outputDir}", "--emptyOutDir"],
      cwd: ".",
      timeoutMs: 60_000,
    },
    route: "/",
    outputDirectoryName: "build",
    fixtureQueryParameter: "fixture",
    interactions: [
      {
        id: "search-filters-projects",
        fixtureId: "populated",
        viewportId: "desktop",
        steps: [
          { action: "click", selector: "[data-testid=project-search]" },
          { action: "fill", selector: "[data-testid=project-search]", value: "첫 번째" },
          { action: "expect-count", selector: "[data-testid=project-item]", count: 1 },
          { action: "expect-text", selector: "[data-testid=project-item]", text: "첫 번째 프로젝트" },
        ],
      },
    ],
  };
  const expectedEvidence = resolve(repositoryRoot, `packages/verifier/evidence/sample-run/run-${process.pid}`);
  if (resolve(durableEvidenceRoot) !== expectedEvidence) throw new Error("Refusing to clean an unexpected evidence path");
  await rm(durableEvidenceRoot, { recursive: true, force: true });
  await mkdir(durableEvidenceRoot, { recursive: true });
}, 120_000);

afterAll(async () => {
  const allowedPrefix = resolve(sampleRoot, ".test-candidates-");
  if (resolve(temporaryRoot).startsWith(allowedPrefix)) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("trusted Playwright candidate verifier", () => {
  it("builds and measures the frozen 64/260/fill candidate across all fixtures and viewports", async () => {
    const candidate = await freezeSample("passing-260");
    const report = await verifyCandidate(inputFor(candidate, durableEvidenceRoot));
    expect(report.status).toBe("PASS");
    expect(report.checks.map(({ kind, status }) => ({ kind, status }))).toEqual(
      expect.arrayContaining([
        { kind: "integrity", status: "PASS" },
        { kind: "schema", status: "PASS" },
        { kind: "policy", status: "PASS" },
        { kind: "types", status: "PASS" },
        { kind: "build", status: "PASS" },
        { kind: "layout", status: "PASS" },
        { kind: "interactions", status: "PASS" },
      ]),
    );
    const boundaryWidthCount = contract.verification.boundaryTests
      ? new Set(contract.breakpoints.flatMap((breakpoint) => breakpoint.minWidth > 0 ? [breakpoint.minWidth - 1, breakpoint.minWidth, breakpoint.minWidth + 1] : [])).size
      : 0;
    expect(report.measurements).toHaveLength((contract.verification.viewports.length + boundaryWidthCount) * contract.verification.fixtureIds.length);
    const desktop = report.measurements.find((item) => item.viewportId === "desktop" && item.fixtureId === "populated");
    expect(desktop?.nodes.header?.height).toBeCloseTo(64, 3);
    expect(desktop?.nodes.sidebar?.width).toBeCloseTo(260, 3);
    expect(desktop?.nodes.main?.left).toBeCloseTo(260, 3);
    const compact = report.measurements.find((item) => item.viewportId === "compact" && item.fixtureId === "populated");
    expect(compact?.nodes.sidebar?.visible).toBe(false);
    expect(compact?.nodes.main?.left).toBeCloseTo(0, 3);
    expect(report.artifacts.filter((item) => item.kind === "screenshot")).toHaveLength(report.measurements.length);
    const { evidenceDigest: _, ...digestPayload } = report;
    expect(report.evidenceDigest).toBe(hashCanonical(digestPayload));
  }, 180_000);

  it("fails a genuinely rendered candidate whose sidebar is 320px", async () => {
    const candidate = await freezeSample("violating-320", 320);
    const report = await verifyCandidate(inputFor(candidate, durableEvidenceRoot));
    expect(report.status).toBe("FAIL");
    expect(report.checks.find((item) => item.kind === "layout")?.status).toBe("FAIL");
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "layout",
          nodeId: "sidebar",
          viewportId: "desktop",
          expected: expect.objectContaining({ value: 260 }),
          actual: 320,
        }),
      ]),
    );
  }, 180_000);

  it("fails the real search interaction when a transparent overlay intercepts pointer input", async () => {
    const candidate = await freezeSample("search-overlay", 260, true);
    const report = await verifyCandidate(inputFor(candidate, durableEvidenceRoot));
    expect(report.status).toBe("FAIL");
    expect(report.checks.find((item) => item.kind === "interactions")?.status).toBe("FAIL");
    expect(report.violations).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "interactions", kind: "interaction" })]));
  }, 180_000);

  it("returns STALE without building when a frozen candidate is modified", async () => {
    const candidate = await freezeSample("tampered");
    await writeFile(join(candidate.snapshotRoot, "src/App.tsx"), "// modified after freeze\n", "utf8");
    const evidenceRoot = join(temporaryRoot, "tamper-evidence");
    const report = await verifyCandidate(inputFor(candidate, evidenceRoot));
    expect(report.status).toBe("STALE");
    expect(report.checks.find((item) => item.kind === "integrity")?.status).toBe("FAIL");
    expect(report.checks.find((item) => item.kind === "build")?.status).toBe("NOT_RUN");
    expect(report.artifacts.some((item) => item.kind === "screenshot")).toBe(false);
  });

  it("returns STALE for a profile hash mismatch instead of trusting the command", async () => {
    const candidate = await freezeSample("profile-mismatch");
    const mismatched: VerificationProfile = { ...profile, route: "/candidate-controlled" };
    const report = await verifyCandidate({ ...inputFor(candidate, join(temporaryRoot, "profile-evidence")), profile: mismatched });
    expect(report.status).toBe("STALE");
    expect(report.checks.find((item) => item.kind === "schema")?.status).toBe("FAIL");
    expect(report.checks.find((item) => item.kind === "build")?.status).toBe("NOT_RUN");
  });
});
