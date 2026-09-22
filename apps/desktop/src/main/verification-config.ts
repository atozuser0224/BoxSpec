import { loadDevelopmentVerificationProfile, loadPackagedVerificationProfile } from "@boxspec/runtime";
import type { RuntimeVerificationConfig } from "./runtime-adapter";

/** Thin composition over the verifier-owned trust validator. */
export async function loadPackagedVerificationConfig(input: {
  resourcesPath: string;
  executablePath: string;
}): Promise<RuntimeVerificationConfig> {
  const loaded = await loadPackagedVerificationProfile(input.resourcesPath, input.executablePath);
  return {
    verificationProfiles: { [loaded.verificationProfileId]: loaded.profile },
    defaultVerificationProfileId: loaded.verificationProfileId,
    fixtures: loaded.fixtures,
    approvedExecutionProfileIds: [loaded.executionProfileId],
  };
}

export async function loadDevelopmentVerificationConfig(input: {
  applicationPath: string;
  executablePath: string;
}): Promise<RuntimeVerificationConfig> {
  const loaded = await loadDevelopmentVerificationProfile(input.applicationPath, input.executablePath);
  return toRuntimeVerificationConfig(loaded);
}

function toRuntimeVerificationConfig(loaded: Awaited<ReturnType<typeof loadPackagedVerificationProfile>>): RuntimeVerificationConfig {
  return {
    verificationProfiles: { [loaded.verificationProfileId]: loaded.profile },
    defaultVerificationProfileId: loaded.verificationProfileId,
    fixtures: loaded.fixtures,
    approvedExecutionProfileIds: [loaded.executionProfileId],
  };
}
