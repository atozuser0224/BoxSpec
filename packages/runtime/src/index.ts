import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createChangeManager, type ChangeManagerControllers } from "@boxspec/change-manager";
import { verifyCandidate, type VerificationProfile, type VerifyCandidateInput, type VerificationReport } from "@boxspec/verifier";
import type { BoxSpecRuntime } from "@boxspec/shared/runtime";
import { BoxSpecApplicationRuntime, type RuntimeOptions } from "./runtime.js";
import { RuntimeLease } from "./runtime-lease.js";

export interface CreateBoxSpecRuntimeOptions {
  readonly dataDir: string;
  readonly verificationProfiles?: Readonly<Record<string, VerificationProfile>>;
  readonly defaultVerificationProfileId?: string;
  readonly fixtures?: Readonly<Record<string, unknown>>;
  readonly allowedWritePaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly approvedExecutionProfileIds?: readonly string[];
  readonly mcpLauncherPath?: string;
  readonly mcpLauncherArgs?: readonly string[];
  readonly nativeSafeFs?: { readonly binaryPath: string; readonly expectedSha256: string };
  readonly clock?: () => Date;
  readonly idGenerator?: (prefix: string) => string;
  /** Test/composition seam; production callers leave this unset. */
  readonly changeManager?: ChangeManagerControllers;
  /** Test/composition seam; production callers leave this unset. */
  readonly verifier?: (input: VerifyCandidateInput) => Promise<VerificationReport>;
}

export async function createBoxSpecRuntime(options: CreateBoxSpecRuntimeOptions): Promise<BoxSpecApplicationRuntime> {
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const lease = await RuntimeLease.acquire(join(dataDir, "runtime.lock"));
  try {
    const changeManager = options.changeManager ?? createChangeManager({
      stateRoot: join(dataDir, "change-manager"),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.nativeSafeFs ? { nativeSafeFs: options.nativeSafeFs } : {}),
    });
    const runtimeOptions: RuntimeOptions = {
      dataDir,
      changeManager,
      verifyCandidate: options.verifier ?? verifyCandidate,
      lease,
      ...(options.verificationProfiles ? { verificationProfiles: options.verificationProfiles } : {}),
      ...(options.defaultVerificationProfileId ? { defaultVerificationProfileId: options.defaultVerificationProfileId } : {}),
      ...(options.fixtures ? { fixtures: options.fixtures } : {}),
      ...(options.allowedWritePaths ? { allowedWritePaths: options.allowedWritePaths } : {}),
      ...(options.protectedPaths ? { protectedPaths: options.protectedPaths } : {}),
      ...(options.approvedExecutionProfileIds ? { approvedExecutionProfileIds: options.approvedExecutionProfileIds } : {}),
      ...(options.mcpLauncherPath ? { mcpLauncherPath: options.mcpLauncherPath } : {}),
      ...(options.mcpLauncherArgs ? { mcpLauncherArgs: options.mcpLauncherArgs } : {}),
      ...(options.nativeSafeFs ? { nativeSafeFs: options.nativeSafeFs } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    };
    return await BoxSpecApplicationRuntime.open(runtimeOptions);
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export { BoxSpecApplicationRuntime, normalizeVerificationCheckStatus } from "./runtime.js";
export { RuntimeError } from "./errors.js";
export type { McpSessionBinding, RuntimeOptions } from "./runtime.js";
export type { BoxSpecRuntime, CoreUseCases, DesktopUseCases } from "@boxspec/shared/runtime";
export {
  createPackagedVerificationProfile,
  loadDevelopmentVerificationProfile,
  loadPackagedVerificationProfile,
  VerificationToolsUnavailableError,
} from "@boxspec/verifier";
export type {
  PackagedVerificationProfile,
  PackagedVerificationProfileInput,
} from "@boxspec/verifier";
