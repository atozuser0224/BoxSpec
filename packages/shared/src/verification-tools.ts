import type { ExecutionProfileId, Sha256, VerificationProfileId } from "./domain.js";

export interface VerificationToolAsset {
  /** Forward-slash path relative to Electron's process.resourcesPath. */
  readonly relativePath: string;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
}

export interface VerificationCommandManifest {
  readonly entryPoint: VerificationToolAsset;
  readonly args: readonly string[];
  readonly cwd: ".";
  readonly timeoutMs: number;
  readonly environment: { readonly ELECTRON_RUN_AS_NODE: "1" };
}

export interface VerificationFixtureManifest extends VerificationToolAsset {
  readonly id: "empty" | "loading" | "error" | "long-text" | "populated";
}

export type VerificationAssetClosureRoot = "verification/toolchain" | "verification/browser";

/** A separately hashed inventory whose entries must exactly match every regular file beneath root. */
export interface VerificationAssetClosure {
  readonly schemaVersion: "1.0.0";
  readonly root: VerificationAssetClosureRoot;
  /** Strict ordinal order by relativePath; paths remain relative to process.resourcesPath. */
  readonly entries: readonly VerificationToolAsset[];
}

export interface VerificationToolsManifest {
  readonly schemaVersion: "1.0.0";
  readonly verificationProfileId: VerificationProfileId;
  readonly executionProfileId: ExecutionProfileId;
  readonly generatorVersion: string;
  /** Identity of process.execPath. Its location is never read from this manifest. */
  readonly applicationExecutable: { readonly sha256: Sha256; readonly sizeBytes: number };
  readonly typecheck: VerificationCommandManifest;
  readonly build: VerificationCommandManifest;
  /** Hash/size identity of the JSON inventory sealing the complete toolchain directory. */
  readonly toolchainManifest: VerificationToolAsset;
  readonly browser: VerificationToolAsset & {
    readonly engine: "chromium";
    readonly playwrightVersion: "1.63.0";
    readonly chromiumRevision: "1243";
    readonly browserVersion: string;
  };
  /** Hash/size identity of the JSON inventory sealing the complete browser directory. */
  readonly browserManifest: VerificationToolAsset;
  readonly fixtures: readonly VerificationFixtureManifest[];
  readonly route: "/index.html";
  readonly outputDirectoryName: "dist";
  readonly fixtureQueryParameter: "fixture";
}

const FIXTURE_IDS = ["empty", "loading", "error", "long-text", "populated"] as const;

/** Strictly validates the packaged manifest before any path is resolved or process is launched. */
export function parseVerificationToolsManifest(input: unknown): VerificationToolsManifest {
  const root = record(input, "manifest", [
    "schemaVersion", "verificationProfileId", "executionProfileId", "generatorVersion", "applicationExecutable",
    "typecheck", "build", "toolchainManifest", "browser", "browserManifest", "fixtures", "route", "outputDirectoryName", "fixtureQueryParameter",
  ]);
  if (root.schemaVersion !== "1.0.0") fail("schemaVersion must be 1.0.0");
  if (root.verificationProfileId !== "managed-react-vite-p1" || root.executionProfileId !== "managed-react-vite-p1") fail("profile ids must be managed-react-vite-p1");
  if (typeof root.generatorVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(root.generatorVersion)) fail("generatorVersion is invalid");
  const executable = identity(root.applicationExecutable, "applicationExecutable");
  const typecheck = command(root.typecheck, "typecheck", 5_000, 300_000);
  const build = command(root.build, "build", 5_000, 600_000);
  const toolchainManifest = asset(root.toolchainManifest, "toolchainManifest");
  const browserValue = record(root.browser, "browser", ["relativePath", "sha256", "sizeBytes", "engine", "playwrightVersion", "chromiumRevision", "browserVersion"]);
  const browserAsset = asset(browserValue, "browser", ["engine", "playwrightVersion", "chromiumRevision", "browserVersion"]);
  if (browserValue.engine !== "chromium" || browserValue.playwrightVersion !== "1.63.0" || browserValue.chromiumRevision !== "1243") fail("browser identity is unsupported");
  if (typeof browserValue.browserVersion !== "string" || !/^[0-9]+(?:\.[0-9]+){2,3}$/.test(browserValue.browserVersion)) fail("browserVersion is invalid");
  const browserManifest = asset(root.browserManifest, "browserManifest");
  if (!toolchainManifest.relativePath.startsWith("verification/manifests/") || !browserManifest.relativePath.startsWith("verification/manifests/") || toolchainManifest.relativePath === browserManifest.relativePath) {
    fail("closure manifests must be distinct files beneath verification/manifests");
  }
  if (!Array.isArray(root.fixtures) || root.fixtures.length !== FIXTURE_IDS.length) fail("fixtures must contain the five managed fixtures");
  const seen = new Set<string>();
  const fixtures = root.fixtures.map((value, index) => {
    const item = record(value, `fixtures[${index}]`, ["id", "relativePath", "sha256", "sizeBytes"]);
    if (!FIXTURE_IDS.includes(item.id as (typeof FIXTURE_IDS)[number]) || seen.has(String(item.id))) fail(`fixtures[${index}].id is invalid or duplicated`);
    seen.add(String(item.id));
    return { id: item.id, ...asset(item, `fixtures[${index}]`, ["id"]) } as VerificationFixtureManifest;
  });
  if (FIXTURE_IDS.some((id) => !seen.has(id))) fail("fixtures are incomplete");
  if (root.route !== "/index.html" || root.outputDirectoryName !== "dist" || root.fixtureQueryParameter !== "fixture") fail("managed route/profile constants are invalid");
  const browser: VerificationToolsManifest["browser"] = {
    ...browserAsset,
    engine: "chromium",
    playwrightVersion: "1.63.0",
    chromiumRevision: "1243",
    browserVersion: browserValue.browserVersion as string,
  };
  return Object.freeze({
    schemaVersion: "1.0.0",
    verificationProfileId: root.verificationProfileId as VerificationProfileId,
    executionProfileId: root.executionProfileId as ExecutionProfileId,
    generatorVersion: root.generatorVersion as string,
    applicationExecutable: executable,
    typecheck,
    build,
    toolchainManifest,
    browser,
    browserManifest,
    fixtures: Object.freeze(fixtures),
    route: "/index.html",
    outputDirectoryName: "dist",
    fixtureQueryParameter: "fixture",
  });
}

/** Validates the bytes referenced by a top-level closure-manifest asset. */
export function parseVerificationAssetClosure(input: unknown, expectedRoot: VerificationAssetClosureRoot): VerificationAssetClosure {
  const value = record(input, "assetClosure", ["schemaVersion", "root", "entries"]);
  if (value.schemaVersion !== "1.0.0" || value.root !== expectedRoot) fail(`asset closure must identify ${expectedRoot}`);
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 100_000) fail("asset closure entries are invalid");
  const entries = value.entries.map((entry, index) => asset(entry, `assetClosure.entries[${index}]`));
  let previous = "";
  const foldedPaths = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!entry.relativePath.startsWith(`${expectedRoot}/`)) fail(`asset closure entry is outside ${expectedRoot}`);
    if (index > 0 && ordinalCompare(previous, entry.relativePath) >= 0) fail("asset closure entries must be unique and ordinal sorted");
    const foldedPath = windowsCaseFold(entry.relativePath);
    if (foldedPaths.has(foldedPath)) fail("asset closure entries must be unique under Windows case folding");
    foldedPaths.add(foldedPath);
    previous = entry.relativePath;
  }
  return Object.freeze({ schemaVersion: "1.0.0", root: expectedRoot, entries: Object.freeze(entries) });
}

function command(input: unknown, path: string, minimum: number, maximum: number): VerificationCommandManifest {
  const value = record(input, path, ["entryPoint", "args", "cwd", "timeoutMs", "environment"]);
  if (value.cwd !== "." || !Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < minimum || (value.timeoutMs as number) > maximum) fail(`${path} cwd/timeout is invalid`);
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string" || arg.length > 512 || /[\r\n\0]/.test(arg))) fail(`${path}.args is invalid`);
  const environment = record(value.environment, `${path}.environment`, ["ELECTRON_RUN_AS_NODE"]);
  if (environment.ELECTRON_RUN_AS_NODE !== "1") fail(`${path}.environment is invalid`);
  const environmentValue: VerificationCommandManifest["environment"] = { ELECTRON_RUN_AS_NODE: "1" };
  return Object.freeze({ entryPoint: asset(value.entryPoint, `${path}.entryPoint`), args: Object.freeze([...value.args]) as readonly string[], cwd: ".", timeoutMs: value.timeoutMs as number, environment: environmentValue });
}

function asset(input: unknown, path: string, additionalFields: readonly string[] = []): VerificationToolAsset {
  const value = record(input, path, ["relativePath", "sha256", "sizeBytes", ...additionalFields]);
  if (typeof value.relativePath !== "string" || !safeRelativePath(value.relativePath)) fail(`${path}.relativePath is unsafe`);
  return { relativePath: value.relativePath, ...identityFields(value, path) };
}

function identity(input: unknown, path: string): { readonly sha256: Sha256; readonly sizeBytes: number } {
  const value = record(input, path, ["sha256", "sizeBytes"]);
  return identityFields(value, path);
}

function identityFields(value: Record<string, unknown>, path: string): { readonly sha256: Sha256; readonly sizeBytes: number } {
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) fail(`${path}.sha256 is invalid`);
  if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) <= 0) fail(`${path}.sizeBytes is invalid`);
  return { sha256: value.sha256 as Sha256, sizeBytes: value.sizeBytes as number };
}

function safeRelativePath(value: string): boolean {
  if (!value.startsWith("verification/") || value.includes("\\") || value.includes(":")) return false;
  const parts = value.split("/");
  return parts.every((part) => {
    if (part.length === 0 || part === "." || part === ".." || /[\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part)) return false;
    const stem = part.split(".", 1)[0]!.toUpperCase();
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
  });
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function windowsCaseFold(value: string): string {
  return value.toUpperCase();
}

function record(input: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`${path} must be an object`);
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in value))) fail(`${path} has missing or extra fields`);
  return value;
}

function fail(message: string): never { throw new TypeError(`Invalid verification tools manifest: ${message}`); }
