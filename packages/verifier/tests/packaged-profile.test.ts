import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPackagedVerificationProfile,
  loadPackagedVerificationProfile,
  VerificationToolsUnavailableError,
} from "../src/index.js";
import { sha256Bytes } from "../src/hash.js";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function stage() {
  const root = await mkdtemp(join(tmpdir(), "boxspec-tools-"));
  cleanup.push(root);
  const fixtures = {
    empty: { state: "empty", items: [], error: null },
    loading: { state: "loading", items: [], error: null },
    error: { state: "error", items: [], error: "failed" },
    "long-text": { state: "long-text", items: [{ id: "long", name: "Long project" }], error: null },
    populated: { state: "populated", items: [{ id: "one", name: "첫 번째 프로젝트" }], error: null },
  } as const;
  const add = async (relativePath: string, contents: string | Uint8Array) => {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    const bytes = await readFile(path);
    return { relativePath, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength };
  };
  const [typecheck, build, browser, toolchainFile] = await Promise.all([
    add("verification/runners/typecheck-runner.mjs", "// typecheck"),
    add("verification/runners/vite-build-runner.mjs", "// build"),
    add("verification/browser/chrome.exe", "browser"),
    add("verification/toolchain/node_modules/typescript/lib/typescript.js", "toolchain"),
  ]);
  const fixtureAssets = await Promise.all(Object.entries(fixtures).map(async ([id, value]) => ({ id, ...await add(`verification/fixtures/${id}.json`, JSON.stringify(value)) })));
  const executable = await readFile(process.execPath);
  const toolchainClosure = { schemaVersion: "1.0.0", root: "verification/toolchain", entries: [toolchainFile] };
  const browserClosure = { schemaVersion: "1.0.0", root: "verification/browser", entries: [browser] };
  const [toolchainManifest, browserManifest] = await Promise.all([
    add("verification/manifests/toolchain.json", JSON.stringify(toolchainClosure)),
    add("verification/manifests/browser.json", JSON.stringify(browserClosure)),
  ]);
  const manifest = {
    schemaVersion: "1.0.0",
    verificationProfileId: "managed-react-vite-p1",
    executionProfileId: "managed-react-vite-p1",
    generatorVersion: "test-1",
    applicationExecutable: { sha256: sha256Bytes(executable), sizeBytes: executable.byteLength },
    typecheck: { entryPoint: typecheck, args: ["{outputDir}"], cwd: ".", timeoutMs: 30_000, environment: { ELECTRON_RUN_AS_NODE: "1" } },
    build: { entryPoint: build, args: ["{outputDir}"], cwd: ".", timeoutMs: 60_000, environment: { ELECTRON_RUN_AS_NODE: "1" } },
    toolchainManifest,
    browser: { ...browser, engine: "chromium", playwrightVersion: "1.63.0", chromiumRevision: "1243", browserVersion: "153.0.8010.12" },
    browserManifest,
    fixtures: fixtureAssets,
    route: "/index.html",
    outputDirectoryName: "dist",
    fixtureQueryParameter: "fixture",
  };
  await writeFile(join(root, "verification-tools.json"), JSON.stringify(manifest));
  return { root, manifest };
}

describe("packaged verification profile", () => {
  it("creates explicit commands and the five trusted fixtures from verified package bytes", async () => {
    const { root } = await stage();
    const result = await loadPackagedVerificationProfile(root, process.execPath);
    expect(result.verificationProfileId).toBe("managed-react-vite-p1");
    expect(Object.keys(result.fixtures).sort()).toEqual(["empty", "error", "loading", "long-text", "populated"]);
    expect(result.profile.typecheck.executable).toBe(process.execPath);
    expect(result.profile.typecheck.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(result.profile.build.args.at(-1)).toBe("{outputDir}");
    expect(result.profile.browserExecutablePath).toBe(join(root, "verification", "browser", "chrome.exe"));
  });

  it("fails closed when a packaged tool is changed after manifest generation", async () => {
    const { root, manifest } = await stage();
    await writeFile(join(root, "verification", "runners", "vite-build-runner.mjs"), "tampered");
    await expect(createPackagedVerificationProfile({ resourcesRoot: root, applicationExecutablePath: process.execPath, manifest }))
      .rejects.toBeInstanceOf(VerificationToolsUnavailableError);
  });

  it("rejects changed or extra files in a sealed toolchain closure", async () => {
    const changed = await stage();
    await writeFile(join(changed.root, "verification", "toolchain", "node_modules", "typescript", "lib", "typescript.js"), "changed");
    await expect(loadPackagedVerificationProfile(changed.root, process.execPath)).rejects.toThrow(/closure mismatch/i);

    const extra = await stage();
    await writeFile(join(extra.root, "verification", "toolchain", "extra.js"), "extra");
    await expect(loadPackagedVerificationProfile(extra.root, process.execPath)).rejects.toThrow(/missing or extra/i);
  });

  it("fails closed for a missing browser instead of advertising verification readiness", async () => {
    const { root } = await stage();
    await rm(join(root, "verification", "browser", "chrome.exe"));
    await expect(loadPackagedVerificationProfile(root, process.execPath)).rejects.toThrow(/unavailable|ENOENT/i);
  });

  it("rejects a manifest path escape before resolving an asset", async () => {
    const { root, manifest } = await stage();
    const malformed = { ...manifest, browser: { ...manifest.browser, relativePath: "verification/../outside.exe" } };
    await expect(createPackagedVerificationProfile({ resourcesRoot: root, applicationExecutablePath: process.execPath, manifest: malformed }))
      .rejects.toThrow(/unsafe/);
  });
});
