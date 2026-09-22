import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GrantId } from "@boxspec/shared/domain";
import { LOCAL_IPC_PROTOCOL_VERSION, LocalIpcError, type McpPairingProfile } from "./types.js";

const execFileAsync = promisify(execFile);
const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const MAX_PROFILE_BYTES = 16 * 1024;

export function assertSafeProfileName(profileName: string): void {
  if (!SAFE_PROFILE_NAME.test(profileName) || profileName === "." || profileName === ".." || WINDOWS_DEVICE_NAME.test(profileName)) {
    throw new LocalIpcError("INVALID_REQUEST", "Profile name must be a safe filename");
  }
}

export function defaultProfileRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA;
  if (process.platform === "win32" && !localAppData) {
    throw new LocalIpcError("INVALID_REQUEST", "LOCALAPPDATA is unavailable");
  }
  return resolve(localAppData ?? join(process.cwd(), ".boxspec-local"), "BoxSpec", "mcp-profiles");
}

export function profilePath(profileName: string, root = defaultProfileRoot()): string {
  assertSafeProfileName(profileName);
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, `${profileName}.json`);
  if (dirname(target) !== resolvedRoot || basename(target) !== `${profileName}.json`) {
    throw new LocalIpcError("INVALID_REQUEST", "Profile path escaped the profile directory");
  }
  return target;
}

export async function persistProfile(profileName: string, profile: McpPairingProfile, root?: string): Promise<string> {
  const target = profilePath(profileName, root);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await validateProfileDirectory(directory);
  await hardenCurrentUserPath(directory, true);
  const temporary = join(directory, `.${profileName}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(profile)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await hardenCurrentUserPath(temporary, false);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new LocalIpcError("INVALID_REQUEST", "Pairing profile target is not a regular file");
    }
    await rename(temporary, target);
    await hardenCurrentUserPath(target, false);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

export async function loadProfile(profileName: string, root?: string, now = new Date()): Promise<McpPairingProfile> {
  const target = profilePath(profileName, root);
  try {
    await validateProfileDirectory(dirname(target));
  } catch (error) {
    throw new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing profile directory is invalid", { cause: error });
  }
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    throw new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing profile is unavailable", { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROFILE_BYTES) {
    throw new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing profile is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing profile is invalid", { cause: error });
  }
  if (!isProfile(value) || Date.parse(value.expiresAt) <= now.getTime()) {
    throw new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing profile is invalid or expired");
  }
  return value;
}

export async function verifyProfileAccess(profileName: string, root?: string): Promise<void> {
  await access(profilePath(profileName, root), constants.R_OK);
}

async function hardenCurrentUserPath(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  let sid: string;
  try {
    const result = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" });
    const match = /"(S-1-[0-9-]+)"/u.exec(result.stdout);
    if (!match?.[1]) throw new Error("Current user SID was not returned");
    sid = match[1];
    const inheritance = directory ? "(OI)(CI)(F)" : "(F)";
    await execFileAsync(
      "icacls.exe",
      [path, "/inheritance:r", "/grant:r", `*${sid}:${inheritance}`, "/grant:r", `*S-1-5-18:${inheritance}`],
      { windowsHide: true, encoding: "utf8" },
    );
  } catch (error) {
    throw new LocalIpcError("INVALID_REQUEST", "Could not restrict pairing profile access to the current user", { cause: error });
  }
}

async function validateProfileDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing profile directory must be a real directory");
  }
  const resolved = resolve(directory);
  const canonical = await realpath(directory);
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(canonical) !== normalize(resolved)) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing profile directory cannot traverse a link or junction");
  }
}

function isProfile(value: unknown): value is McpPairingProfile {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["expiresAt", "grantId", "pipePath", "principalId", "protocolVersion", "sessionToken"];
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.protocolVersion === LOCAL_IPC_PROTOCOL_VERSION
    && typeof value.pipePath === "string"
    && value.pipePath.startsWith("\\\\.\\pipe\\boxspec-")
    && value.pipePath.length <= 256
    && typeof value.sessionToken === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value.sessionToken)
    && typeof value.principalId === "string"
    && value.principalId.length > 0
    && value.principalId.length <= 256
    && typeof value.grantId === "string"
    && value.grantId.length > 0
    && value.grantId.length <= 256
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function grantIdFromProfile(profile: McpPairingProfile): GrantId {
  return profile.grantId;
}
