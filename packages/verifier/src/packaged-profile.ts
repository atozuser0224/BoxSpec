import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseVerificationToolsManifest,
  parseVerificationAssetClosure,
  type VerificationToolAsset,
  type VerificationToolsManifest,
} from "@boxspec/shared/verification-tools";
import { sha256Bytes } from "./hash.js";
import type { TrustedAssetClosure, VerificationProfile } from "./types.js";

const REQUIRED_FIXTURES = ["empty", "loading", "error", "long-text", "populated"] as const;

export interface PackagedVerificationProfileInput {
  /** Electron's trusted process.resourcesPath. */
  readonly resourcesRoot: string;
  /** Electron's trusted process.execPath. Never read from the manifest or environment. */
  readonly applicationExecutablePath: string;
  /** Parsed as untrusted bytes from resourcesRoot/verification-tools.json. */
  readonly manifest: unknown;
}

export interface PackagedVerificationProfile {
  readonly verificationProfileId: "managed-react-vite-p1";
  readonly executionProfileId: "managed-react-vite-p1";
  readonly generatorVersion: string;
  readonly profile: VerificationProfile;
  readonly fixtures: Readonly<Record<(typeof REQUIRED_FIXTURES)[number], unknown>>;
}

export class VerificationToolsUnavailableError extends Error {
  override readonly name = "VerificationToolsUnavailableError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Loads the only accepted production manifest location and verifies every byte it names. */
export async function loadPackagedVerificationProfile(
  resourcesRoot: string,
  applicationExecutablePath: string,
): Promise<PackagedVerificationProfile> {
  try {
    const manifestPath = await trustedFile(resourcesRoot, "verification-tools.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return await createPackagedVerificationProfile({ resourcesRoot, applicationExecutablePath, manifest });
  } catch (error) {
    if (error instanceof VerificationToolsUnavailableError) throw error;
    throw unavailable("Packaged verification tools are unavailable or malformed", error);
  }
}

/**
 * Development uses the same staged, hash-sealed resource layout as production.
 * `applicationPath` is Electron's app.getAppPath(); no cache, PATH, or environment discovery occurs.
 */
export async function loadDevelopmentVerificationProfile(
  applicationPath: string,
  applicationExecutablePath: string,
): Promise<PackagedVerificationProfile> {
  if (!isAbsolute(applicationPath)) throw unavailable("Development application path must be absolute", new Error(applicationPath));
  const resourcesRoot = resolve(applicationPath, "..", "..", "build", "verification-dev");
  return loadPackagedVerificationProfile(resourcesRoot, applicationExecutablePath);
}

/** Converts a strictly validated, byte-verified package manifest into verifier inputs. */
export async function createPackagedVerificationProfile(
  input: PackagedVerificationProfileInput,
): Promise<PackagedVerificationProfile> {
  try {
    if (!isAbsolute(input.resourcesRoot) || !isAbsolute(input.applicationExecutablePath)) {
      throw new Error("resourcesRoot and applicationExecutablePath must be absolute trusted paths");
    }
    const manifest = parseVerificationToolsManifest(input.manifest);
    await verifyApplicationExecutable(input.applicationExecutablePath, manifest);

    const [typecheckEntry, buildEntry, browserPath, toolchainClosure, browserClosure] = await Promise.all([
      verifiedAsset(input.resourcesRoot, manifest.typecheck.entryPoint),
      verifiedAsset(input.resourcesRoot, manifest.build.entryPoint),
      verifiedAsset(input.resourcesRoot, manifest.browser),
      verifiedClosure(input.resourcesRoot, manifest.toolchainManifest, "verification/toolchain"),
      verifiedClosure(input.resourcesRoot, manifest.browserManifest, "verification/browser"),
    ]);
    const fixturePairs = await Promise.all(
      manifest.fixtures.map(async (fixture) => {
        const path = await verifiedAsset(input.resourcesRoot, fixture);
        return [fixture.id, parseFixture(fixture.id, JSON.parse(await readFile(path, "utf8")) as unknown)] as const;
      }),
    );
    const fixtures = Object.freeze(Object.fromEntries(fixturePairs)) as Readonly<Record<(typeof REQUIRED_FIXTURES)[number], unknown>>;

    const profile: VerificationProfile = Object.freeze({
      typecheck: command(input.applicationExecutablePath, manifest.applicationExecutable.sha256, typecheckEntry, manifest.typecheck),
      build: command(input.applicationExecutablePath, manifest.applicationExecutable.sha256, buildEntry, manifest.build),
      route: manifest.route,
      outputDirectoryName: manifest.outputDirectoryName,
      fixtureQueryParameter: manifest.fixtureQueryParameter,
      browserExecutablePath: browserPath,
      browserExecutableSha256: manifest.browser.sha256,
      trustedAssetClosures: Object.freeze([toolchainClosure, browserClosure]),
      interactions: Object.freeze([
        Object.freeze({
          id: "managed-search",
          fixtureId: "populated",
          viewportId: "desktop",
          steps: Object.freeze([
            Object.freeze({ action: "expect-visible" as const, selector: "[data-testid='project-search']" }),
            Object.freeze({ action: "fill" as const, selector: "[data-testid='project-search']", value: "첫 번째" }),
            Object.freeze({ action: "expect-count" as const, selector: "[data-testid='project-item']", count: 1 }),
            Object.freeze({ action: "expect-text" as const, selector: "[data-testid='project-item']", text: "첫 번째 프로젝트" }),
          ]),
        }),
      ]),
    });
    return Object.freeze({
      verificationProfileId: "managed-react-vite-p1",
      executionProfileId: "managed-react-vite-p1",
      generatorVersion: manifest.generatorVersion,
      profile,
      fixtures,
    });
  } catch (error) {
    if (error instanceof VerificationToolsUnavailableError) throw error;
    throw unavailable("Packaged verification tools failed trust validation", error);
  }
}

export async function verifyTrustedAssetClosures(closures: readonly TrustedAssetClosure[] | undefined): Promise<void> {
  if (!closures) return;
  for (const closure of closures) {
    if (!isAbsolute(closure.resourcesRoot) || !isAbsolute(closure.rootPath)) throw new Error("Trusted asset closure roots must be absolute");
    const expectedRoot = relative(resolve(closure.resourcesRoot), resolve(closure.rootPath)).replaceAll("\\", "/");
    if (expectedRoot !== "verification/toolchain" && expectedRoot !== "verification/browser") throw new Error("Trusted asset closure has an unsupported root");
    const actual = await enumerateClosure(closure.resourcesRoot, expectedRoot);
    if (actual.length !== closure.entries.length) throw new Error(`Trusted asset closure file set changed: ${expectedRoot}`);
    for (let index = 0; index < actual.length; index += 1) {
      const left = actual[index];
      const right = closure.entries[index];
      if (!left || !right || left.relativePath !== right.relativePath || left.sizeBytes !== right.sizeBytes || left.sha256 !== right.sha256) {
        throw new Error(`Trusted asset closure mismatch: ${right?.relativePath ?? left?.relativePath ?? expectedRoot}`);
      }
    }
  }
}

async function verifiedClosure(
  resourcesRoot: string,
  pointer: VerificationToolAsset,
  expectedRoot: "verification/toolchain" | "verification/browser",
): Promise<TrustedAssetClosure> {
  const manifestPath = await verifiedAsset(resourcesRoot, pointer);
  const closure = parseVerificationAssetClosure(JSON.parse(await readFile(manifestPath, "utf8")) as unknown, expectedRoot);
  const actual = await enumerateClosure(resourcesRoot, expectedRoot);
  if (actual.length !== closure.entries.length) throw new Error(`Packaged ${expectedRoot} closure contains missing or extra files`);
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = closure.entries[index];
    if (!left || !right || left.relativePath !== right.relativePath || left.sizeBytes !== right.sizeBytes || left.sha256 !== right.sha256) {
      throw new Error(`Packaged closure mismatch: ${right?.relativePath ?? left?.relativePath ?? expectedRoot}`);
    }
  }
  return Object.freeze({
    resourcesRoot: resolve(resourcesRoot),
    rootPath: resolve(resourcesRoot, ...expectedRoot.split("/")),
    entries: Object.freeze(actual),
  });
}

async function enumerateClosure(resourcesRoot: string, closureRoot: string): Promise<readonly { relativePath: string; sha256: string; sizeBytes: number }[]> {
  const rootPath = resolve(resourcesRoot, ...closureRoot.split("/"));
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Packaged closure root is not a real directory: ${closureRoot}`);
  const paths: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const childPath = resolve(directory, child.name);
      const info = await lstat(childPath);
      if (info.isSymbolicLink()) throw new Error(`Packaged closure contains a symbolic link or junction: ${closureRoot}/${childRelative}`);
      if (info.isDirectory()) await visit(childPath, childRelative);
      else if (info.isFile()) {
        if (info.nlink !== 1) throw new Error(`Packaged closure contains a hardlink: ${closureRoot}/${childRelative}`);
        paths.push(`${closureRoot}/${childRelative}`);
      } else throw new Error(`Packaged closure contains an unsupported entry: ${closureRoot}/${childRelative}`);
    }
  }
  await visit(rootPath, "");
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const folded = new Set<string>();
  for (const path of paths) {
    const windowsIdentity = path.toLowerCase();
    if (folded.has(windowsIdentity)) throw new Error(`Packaged closure contains a Windows case-fold duplicate: ${path}`);
    folded.add(windowsIdentity);
  }
  return Promise.all(paths.map(async (relativePath) => {
    const path = await trustedFile(resourcesRoot, relativePath);
    const bytes = await readFile(path);
    return { relativePath, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength };
  }));
}

function command(
  executable: string,
  executableSha256: string,
  entryPoint: string,
  manifest: VerificationToolsManifest["build"] | VerificationToolsManifest["typecheck"],
) {
  return Object.freeze({
    executable,
    executableSha256,
    args: Object.freeze([entryPoint, ...manifest.args]),
    cwd: manifest.cwd,
    timeoutMs: manifest.timeoutMs,
    env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
  });
}

async function verifyApplicationExecutable(path: string, manifest: VerificationToolsManifest): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== manifest.applicationExecutable.sizeBytes) {
    throw new Error("Application executable size does not match the package manifest");
  }
  if (sha256Bytes(await readFile(path)) !== manifest.applicationExecutable.sha256) {
    throw new Error("Application executable hash does not match the package manifest");
  }
}

async function verifiedAsset(resourcesRoot: string, asset: VerificationToolAsset): Promise<string> {
  const path = await trustedFile(resourcesRoot, asset.relativePath);
  const metadata = await stat(path);
  if (metadata.size !== asset.sizeBytes) throw new Error(`Packaged asset size mismatch: ${asset.relativePath}`);
  if (sha256Bytes(await readFile(path)) !== asset.sha256) throw new Error(`Packaged asset hash mismatch: ${asset.relativePath}`);
  return path;
}

async function trustedFile(resourcesRoot: string, relativePath: string): Promise<string> {
  const root = resolve(resourcesRoot);
  const path = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Packaged path escapes resources root: ${relativePath}`);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("resourcesRoot must be a real directory");
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Packaged path contains a symbolic link or junction: ${relativePath}`);
  }
  const [rootReal, fileReal, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  const realRel = relative(rootReal, fileReal);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`Packaged path resolves outside resources root: ${relativePath}`);
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Packaged asset must be a non-hardlinked regular file: ${relativePath}`);
  return fileReal;
}

function parseFixture(id: (typeof REQUIRED_FIXTURES)[number], input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(`Fixture ${id} must be an object`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["state", "items", "error"].includes(key)) || value.state !== id) {
    throw new Error(`Fixture ${id} has an invalid state or extra fields`);
  }
  if (!Array.isArray(value.items) || value.items.some((item) => !validItem(item))) throw new Error(`Fixture ${id} has invalid items`);
  if (value.error !== null && typeof value.error !== "string") throw new Error(`Fixture ${id} has an invalid error`);
  return Object.freeze({ state: id, items: Object.freeze(value.items.map((item) => Object.freeze({ ...(item as object) }))), error: value.error });
}

function validItem(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0;
}

function unavailable(message: string, cause: unknown): VerificationToolsUnavailableError {
  return new VerificationToolsUnavailableError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}
