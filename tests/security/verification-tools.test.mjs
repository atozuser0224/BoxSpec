import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadPackagedVerificationProfile,
  verifyTrustedAssetClosures,
} from "../../packages/verifier/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanup = [];

test.afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function stageProfile() {
  const parent = await mkdtemp(join(tmpdir(), "boxspec-verification-tools-"));
  cleanup.push(parent);
  const resourcesRoot = join(parent, "resources");
  const applicationExecutablePath = join(parent, "BoxSpec.exe");
  await mkdir(resourcesRoot, { recursive: true });
  await writeFile(applicationExecutablePath, "trusted-electron-bytes");

  const writeAsset = async (relativePath, contents) => {
    const path = join(resourcesRoot, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    const bytes = await readFile(path);
    return { relativePath, sha256: sha256(bytes), sizeBytes: bytes.byteLength };
  };

  const typecheck = await writeAsset("verification/runners/typecheck-runner.mjs", "import '../toolchain/node_modules/typescript/lib/typescript.js';\n");
  const build = await writeAsset("verification/runners/vite-build-runner.mjs", "import '../toolchain/node_modules/vite/dist/node/index.js';\n");
  const toolchainEntries = [
    await writeAsset("verification/toolchain/node_modules/typescript/lib/typescript.js", "export const ts = 1;\n"),
    await writeAsset("verification/toolchain/node_modules/vite/dist/node/index.js", "export const build = () => {};\n"),
  ].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const browserEntries = [
    await writeAsset("verification/browser/chrome-headless-shell.exe", "trusted browser"),
    await writeAsset("verification/browser/icudtl.dat", "trusted browser dependency"),
  ].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const browser = browserEntries.find((entry) => entry.relativePath.endsWith(".exe"));
  assert.ok(browser);

  const fixtureValues = {
    empty: { state: "empty", items: [], error: null },
    loading: { state: "loading", items: [], error: null },
    error: { state: "error", items: [], error: "failed" },
    "long-text": { state: "long-text", items: [{ id: "long", name: "Long project" }], error: null },
    populated: { state: "populated", items: [{ id: "one", name: "첫 번째 프로젝트" }], error: null },
  };
  const fixtures = [];
  for (const [id, value] of Object.entries(fixtureValues)) {
    fixtures.push({ id, ...await writeAsset(`verification/fixtures/${id}.json`, JSON.stringify(value)) });
  }

  const toolchainManifest = await writeAsset("verification/manifests/toolchain.json", JSON.stringify({
    schemaVersion: "1.0.0", root: "verification/toolchain", entries: toolchainEntries,
  }));
  const browserManifest = await writeAsset("verification/manifests/browser.json", JSON.stringify({
    schemaVersion: "1.0.0", root: "verification/browser", entries: browserEntries,
  }));
  const executable = await readFile(applicationExecutablePath);
  const manifest = {
    schemaVersion: "1.0.0",
    verificationProfileId: "managed-react-vite-p1",
    executionProfileId: "managed-react-vite-p1",
    generatorVersion: "security-test-1",
    applicationExecutable: { sha256: sha256(executable), sizeBytes: executable.byteLength },
    typecheck: { entryPoint: typecheck, args: [], cwd: ".", timeoutMs: 30_000, environment: { ELECTRON_RUN_AS_NODE: "1" } },
    build: { entryPoint: build, args: ["{outputDir}"], cwd: ".", timeoutMs: 60_000, environment: { ELECTRON_RUN_AS_NODE: "1" } },
    toolchainManifest,
    browser: { ...browser, engine: "chromium", playwrightVersion: "1.63.0", chromiumRevision: "1243", browserVersion: "153.0.8010.12" },
    browserManifest,
    fixtures,
    route: "/index.html",
    outputDirectoryName: "dist",
    fixtureQueryParameter: "fixture",
  };
  await writeFile(join(resourcesRoot, "verification-tools.json"), JSON.stringify(manifest));
  return { parent, resourcesRoot, applicationExecutablePath, manifest };
}

test("packaged verifier profile binds the fixed executable, commands, fixtures, and both complete closures", async () => {
  const staged = await stageProfile();
  const loaded = await loadPackagedVerificationProfile(staged.resourcesRoot, staged.applicationExecutablePath);
  assert.equal(loaded.profile.typecheck.executable, staged.applicationExecutablePath);
  assert.deepEqual(loaded.profile.typecheck.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(Object.keys(loaded.fixtures).sort(), ["empty", "error", "loading", "long-text", "populated"]);
  assert.deepEqual(loaded.profile.trustedAssetClosures?.map((item) => item.entries.length), [2, 2]);
  await verifyTrustedAssetClosures(loaded.profile.trustedAssetClosures);
});

test("tampering an imported toolchain module or browser support file fails closed before reuse", async () => {
  const staged = await stageProfile();
  const loaded = await loadPackagedVerificationProfile(staged.resourcesRoot, staged.applicationExecutablePath);
  await writeFile(join(staged.resourcesRoot, "verification/toolchain/node_modules/typescript/lib/typescript.js"), "tampered import");
  await assert.rejects(verifyTrustedAssetClosures(loaded.profile.trustedAssetClosures), /closure mismatch/i);

  const browserStage = await stageProfile();
  const browserLoaded = await loadPackagedVerificationProfile(browserStage.resourcesRoot, browserStage.applicationExecutablePath);
  await writeFile(join(browserStage.resourcesRoot, "verification/browser/icudtl.dat"), "tampered browser dependency");
  await assert.rejects(verifyTrustedAssetClosures(browserLoaded.profile.trustedAssetClosures), /closure mismatch/i);
});

test("missing, extra, hardlinked, junction-backed, and manifest-tampered assets are rejected", async (t) => {
  const missing = await stageProfile();
  await unlink(join(missing.resourcesRoot, "verification/browser/icudtl.dat"));
  await assert.rejects(loadPackagedVerificationProfile(missing.resourcesRoot, missing.applicationExecutablePath), /missing or extra/i);

  const extra = await stageProfile();
  await writeFile(join(extra.resourcesRoot, "verification/toolchain/extra-native.node"), "extra executable module");
  await assert.rejects(loadPackagedVerificationProfile(extra.resourcesRoot, extra.applicationExecutablePath), /missing or extra/i);

  const hardlinked = await stageProfile();
  const external = join(hardlinked.parent, "external.dll");
  await writeFile(external, "hardlinked dependency");
  await unlink(join(hardlinked.resourcesRoot, "verification/browser/icudtl.dat"));
  await link(external, join(hardlinked.resourcesRoot, "verification/browser/icudtl.dat"));
  await assert.rejects(loadPackagedVerificationProfile(hardlinked.resourcesRoot, hardlinked.applicationExecutablePath), /hardlink|closure mismatch/i);

  const junction = await stageProfile();
  const externalDirectory = join(junction.parent, "external-directory");
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, "dependency.js"), "outside");
  const junctionPath = join(junction.resourcesRoot, "verification/toolchain/junction");
  try {
    await symlink(externalDirectory, junctionPath, "junction");
    await assert.rejects(loadPackagedVerificationProfile(junction.resourcesRoot, junction.applicationExecutablePath), /symbolic link|junction/i);
  } catch (error) {
    if (error?.code === "EPERM") t.diagnostic("Junction creation is unavailable for this Windows account");
    else throw error;
  }

  const manifestTamper = await stageProfile();
  await writeFile(join(manifestTamper.resourcesRoot, "verification/manifests/toolchain.json"), "{}");
  await assert.rejects(loadPackagedVerificationProfile(manifestTamper.resourcesRoot, manifestTamper.applicationExecutablePath), /(?:size|hash) mismatch/i);
});

test("missing top manifest, fixture tamper, and executable mismatch disable the factory", async () => {
  const missing = await stageProfile();
  await unlink(join(missing.resourcesRoot, "verification-tools.json"));
  await assert.rejects(loadPackagedVerificationProfile(missing.resourcesRoot, missing.applicationExecutablePath), /unavailable|ENOENT/i);

  const fixture = await stageProfile();
  await writeFile(join(fixture.resourcesRoot, "verification/fixtures/populated.json"), "{}");
  await assert.rejects(loadPackagedVerificationProfile(fixture.resourcesRoot, fixture.applicationExecutablePath), /(?:size|hash) mismatch/i);

  const executable = await stageProfile();
  await writeFile(executable.applicationExecutablePath, "different application");
  await assert.rejects(loadPackagedVerificationProfile(executable.resourcesRoot, executable.applicationExecutablePath), /executable (size|hash)/i);
});

test("desktop production composition uses only Electron-owned roots and gates capability on verified configuration", async () => {
  const [main, adapter, loader] = await Promise.all([
    readFile(join(repoRoot, "apps/desktop/src/main/main.ts"), "utf8"),
    readFile(join(repoRoot, "apps/desktop/src/main/runtime-adapter.ts"), "utf8"),
    readFile(join(repoRoot, "apps/desktop/src/main/verification-config.ts"), "utf8"),
  ]);
  assert.match(main, /app\.isPackaged\s*\?\s*await loadPackagedVerificationConfig\(\{ resourcesPath: process\.resourcesPath, executablePath: process\.execPath \}\)/s);
  assert.doesNotMatch(main, /BOXSPEC_(?:VERIFICATION|BROWSER|TOOLCHAIN)/);
  assert.match(adapter, /verifier:\s*this\.verificationConfigured\s*&&\s*this\.has\(\["desktop", "inspectReview"\]\)/);
  assert.match(loader, /loadPackagedVerificationProfile\(input\.resourcesPath, input\.executablePath\)/);
  assert.doesNotMatch(loader, /process\.env|candidate|payload/);
});
