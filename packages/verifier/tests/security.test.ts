import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCandidateIntegrity,
  evaluatePolicy,
  hashCandidateFileEntries,
  inspectCandidateFiles,
  runExplicitCommand,
  type FrozenCandidateDescriptor,
} from "../src/index.js";
import { assertEvidenceOutsideCandidate, sha256Bytes } from "../src/hash.js";

const cleanup: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `boxspec-${name}-`));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path?.startsWith(resolve(tmpdir()))) await rm(path, { recursive: true, force: true });
  }
});

describe("verifier trust boundary", () => {
  it("does not inherit ambient secrets or NODE_OPTIONS into approved commands", async () => {
    const root = await temporaryDirectory("env");
    const nodeHash = sha256Bytes(await readFile(process.execPath));
    process.env.BOXSPEC_TEST_SECRET = "must-not-leak";
    process.env.NODE_OPTIONS = "--no-warnings";
    try {
      const result = await runExplicitCommand(
        {
          executable: process.execPath,
          executableSha256: nodeHash,
          args: ["-e", "process.stdout.write(JSON.stringify({approved:process.env.APPROVED,secret:process.env.BOXSPEC_TEST_SECRET,nodeOptions:process.env.NODE_OPTIONS}))"],
          cwd: ".",
          timeoutMs: 10_000,
          env: { APPROVED: "yes" },
        },
        root,
        join(root, "output"),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ approved: "yes" });
    } finally {
      delete process.env.BOXSPEC_TEST_SECRET;
      delete process.env.NODE_OPTIONS;
    }
  });

  it("refuses to spawn when cancellation already happened", async () => {
    const root = await temporaryDirectory("abort");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runExplicitCommand(
        { executable: process.execPath, executableSha256: sha256Bytes(await readFile(process.execPath)), args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10_000 },
        root,
        join(root, "output"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects hardlinked candidate files", async () => {
    const root = await temporaryDirectory("hardlink");
    await writeFile(join(root, "a.txt"), "same bytes", "utf8");
    await link(join(root, "a.txt"), join(root, "b.txt"));
    await expect(inspectCandidateFiles(root)).rejects.toThrow(/hardlinked/);
  });

  it("rejects an evidence junction that resolves into the candidate", async () => {
    const parent = await temporaryDirectory("junction");
    const candidate = join(parent, "candidate");
    const outside = join(parent, "outside");
    await mkdir(candidate);
    await mkdir(outside);
    const junction = join(outside, "evidence-link");
    await symlink(candidate, junction, "junction");
    await expect(assertEvidenceOutsideCandidate(candidate, junction)).rejects.toThrow(/real directory|outside/);
  });

  it("accepts a bound deletion while still rejecting omitted upserts", async () => {
    const root = await temporaryDirectory("deletion");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const files = await inspectCandidateFiles(root);
    const lock = files[0]!;
    const base = {
      projectId: "p",
      taskId: "t",
      candidateId: "c",
      snapshotRoot: root,
      dependencyLockPath: "pnpm-lock.yaml",
      treeHash: hashCandidateFileEntries(files),
      baseContractHash: "a".repeat(64),
      effectiveContractHash: "a".repeat(64),
      layoutOverridesHash: "b".repeat(64),
      baseContractRevision: 1,
      baseCommitHash: "c".repeat(64),
      baseManifestHash: "d".repeat(64),
      generatorVersion: "test",
      policyHash: "e".repeat(64),
      policyRevision: 1,
      dependencyLockHash: lock.sha256,
      fixturesHash: "f".repeat(64),
      verificationProfileId: "v",
      verificationProfileHash: "1".repeat(64),
      files,
    } as const;
    const deletion: FrozenCandidateDescriptor = {
      ...base,
      changedPaths: ["src/old.ts"],
      changes: [{ relativePath: "src/old.ts", beforeSha256: "2".repeat(64), afterSha256: null, beforeSize: 3, afterSize: null }],
    };
    expect(evaluatePolicy(deletion, { allowedPaths: ["src/**"], protectedPaths: [] })).toEqual([]);
    const omitted: FrozenCandidateDescriptor = {
      ...base,
      changedPaths: ["src/new.ts"],
      changes: [{ relativePath: "src/new.ts", beforeSha256: null, afterSha256: "3".repeat(64), beforeSize: null, afterSize: 3 }],
    };
    expect(evaluatePolicy(omitted, { allowedPaths: ["src/**"], protectedPaths: [] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "change-manifest-mismatch" })]),
    );
  });

  it("matches change-manager trailing-slash directory scopes for allowed and protected paths", () => {
    const changedPath = "src/boxspec/slots/ProjectList.tsx";
    const candidate = {
      projectId: "p",
      taskId: "t",
      candidateId: "c",
      snapshotRoot: "C:\\snapshot",
      dependencyLockPath: "pnpm-lock.yaml",
      treeHash: "0".repeat(64),
      baseContractHash: "1".repeat(64),
      effectiveContractHash: "1".repeat(64),
      layoutOverridesHash: "2".repeat(64),
      baseContractRevision: 1,
      baseCommitHash: "3".repeat(64),
      baseManifestHash: "4".repeat(64),
      generatorVersion: "test",
      policyHash: "5".repeat(64),
      policyRevision: 1,
      dependencyLockHash: "6".repeat(64),
      fixturesHash: "7".repeat(64),
      verificationProfileId: "v",
      verificationProfileHash: "8".repeat(64),
      files: [{ relativePath: changedPath, sha256: "9".repeat(64), size: 12, executable: false }],
      changedPaths: [changedPath],
      changes: [{ relativePath: changedPath, beforeSha256: null, afterSha256: "9".repeat(64), beforeSize: null, afterSize: 12 }],
    } satisfies FrozenCandidateDescriptor;
    expect(evaluatePolicy(candidate, { allowedPaths: ["src/boxspec/"], protectedPaths: [] })).toEqual([]);
    expect(evaluatePolicy(candidate, { allowedPaths: ["src/"], protectedPaths: ["src/boxspec/"] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "protected-path", actual: changedPath })]),
    );
    expect(evaluatePolicy(candidate, { allowedPaths: ["src/box/"], protectedPaths: [] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "outside-allowed-path", actual: changedPath })]),
    );
  });
});
