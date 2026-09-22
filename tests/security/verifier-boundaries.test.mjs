import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeCandidateTreeHash } from "../../packages/change-manager/dist/hash.js";
import {
  assertEvidenceOutsideCandidate,
  hashCandidateFileEntries,
  inspectCandidateFiles,
} from "../../packages/verifier/dist/hash.js";
import { runExplicitCommand } from "../../packages/verifier/dist/process.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "boxspec-security-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("verifier and change-manager use the same candidate tree hash", () => {
  const entries = [
    { relativePath: "src/한글.ts", sha256: "a".repeat(64), size: 7, executable: false },
    { relativePath: "package.json", sha256: "b".repeat(64), size: 19, executable: false },
  ];
  assert.equal(hashCandidateFileEntries(entries), computeCandidateTreeHash(entries));
});

test("candidate inspection rejects a hardlinked file", async () => {
  await withTempDir(async (root) => {
    const first = join(root, "first.txt");
    await writeFile(first, "immutable candidate bytes", "utf8");
    await link(first, join(root, "alias.txt"));
    await assert.rejects(inspectCandidateFiles(root), /non-hardlinked regular file/);
  });
});

test("evidence root resolving into candidate through a junction is rejected", async (t) => {
  await withTempDir(async (root) => {
    const candidate = join(root, "candidate");
    const sink = join(candidate, "evidence-sink");
    const evidence = join(root, "evidence-link");
    await mkdir(sink, { recursive: true });
    try {
      await symlink(sink, evidence, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("junction creation is not permitted on this Windows host");
        return;
      }
      throw error;
    }
    await assert.rejects(assertEvidenceOutsideCandidate(candidate, evidence), /outside the candidate|real directory/);
  });
});

test("explicit verifier commands do not inherit an ambient secret", async () => {
  await withTempDir(async (root) => {
    const secretName = "BOXSPEC_SECURITY_SENTINEL";
    const previous = process.env[secretName];
    process.env[secretName] = "must-not-cross-verifier-boundary";
    try {
      const result = await runExplicitCommand(
        {
          executable: process.execPath,
          executableSha256: sha256(await import("node:fs/promises").then(({ readFile }) => readFile(process.execPath))),
          args: ["-e", `process.stdout.write(JSON.stringify({secret:process.env.${secretName}??null,explicit:process.env.BOXSPEC_EXPLICIT??null}))`],
          cwd: ".",
          env: { BOXSPEC_EXPLICIT: "approved" },
          timeoutMs: 10_000,
        },
        root,
        join(root, "out"),
      );
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), { secret: null, explicit: "approved" });
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });
});

test("an already-aborted command is rejected before spawn", async () => {
  await withTempDir(async (root) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runExplicitCommand(
        {
          executable: process.execPath,
          executableSha256: "0".repeat(64),
          args: ["-e", "process.exit(99)"],
          cwd: ".",
          timeoutMs: 10_000,
        },
        root,
        join(root, "out"),
        controller.signal,
      ),
      { name: "AbortError" },
    );
  });
});

test("verifier timeout terminates a descendant process before it can survive", { skip: process.platform !== "win32", timeout: 10_000 }, async () => {
  await withTempDir(async (root) => {
    const marker = join(root, "descendant-survived.txt");
    const descendant = `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"alive"),1500);setTimeout(()=>{},5000)`;
    const parent = `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:true,stdio:"ignore",windowsHide:true});c.unref();setInterval(()=>{},1000)`;
    const result = await runExplicitCommand(
      {
        executable: process.execPath,
        executableSha256: sha256(await import("node:fs/promises").then(({ readFile }) => readFile(process.execPath))),
        args: ["-e", parent],
        cwd: ".",
        timeoutMs: 250,
      },
      root,
      join(root, "out"),
    );
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await assert.rejects(import("node:fs/promises").then(({ readFile }) => readFile(marker)), (error) => error?.code === "ENOENT");
  });
});
