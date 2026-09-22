#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { GrantId, RequestId } from "@boxspec/shared/domain";
import type { BoxSpecErrorCode, ToolResult } from "@boxspec/shared/errors";
import type { CoreUseCases } from "@boxspec/shared/runtime";
import {
  createIpcCoreAdapter,
  serveBoxSpecStdio,
  type McpPrincipal
} from "@boxspec/bridge";
import { createProfileCoreIpcClient, LocalIpcError } from "@boxspec/local-ipc";

const profileName = parseProfileName(process.argv.slice(2));
const profileRoot = process.env.BOXSPEC_MCP_PROFILE_ROOT;
let closeConnection: (() => Promise<void>) | undefined;
let core: CoreUseCases;
let principal: McpPrincipal;

try {
  const connection = await createProfileCoreIpcClient({
    profileName,
    ...(profileRoot === undefined ? {} : { profileRoot })
  });
  core = createIpcCoreAdapter(connection.client);
  principal = connection.principal;
  closeConnection = connection.close;
} catch (error) {
  const code = error instanceof LocalIpcError ? error.code : "APP_NOT_RUNNING";
  process.stderr.write(`[boxspec-mcp] ${code}: ${safeErrorMessage(error)}\n`);
  principal = {
    kind: "mcp-client",
    principalId: `unavailable-${profileName}`,
    grantId: "unavailable" as GrantId
  };
  core = unavailableCore(code);
}

const handle = serveBoxSpecStdio(core, { principal });
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await Promise.allSettled([
    handle.close(),
    closeConnection?.() ?? Promise.resolve()
  ]);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.stdin.once("end", () => void close());

function parseProfileName(args: readonly string[]): string {
  let profile = "default";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      const value = args[index + 1];
      if (value === undefined) failUsage("--profile requires a value");
      profile = value;
      index += 1;
    } else {
      failUsage(`unknown argument: ${argument ?? ""}`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile === "." || profile === "..") {
    failUsage("profile name is invalid");
  }
  return profile;
}

function failUsage(message: string): never {
  process.stderr.write(`[boxspec-mcp] ${message}\nUsage: boxspec-mcp [--profile NAME]\n`);
  process.exit(2);
}

function unavailableCore(code: BoxSpecErrorCode): CoreUseCases {
  const safeCode: BoxSpecErrorCode = code === "PAIRING_REQUIRED" ? code : "APP_NOT_RUNNING";
  return {
    async invoke(_principal, _tool, input): Promise<ToolResult<unknown>> {
      return {
        ok: false,
        code: safeCode,
        message: safeCode === "PAIRING_REQUIRED"
          ? "BoxSpec MCP pairing is missing, expired, or invalid"
          : "The BoxSpec desktop runtime is not running",
        recoverable: true,
        requestId: extractRequestId(input)
      };
    }
  };
}

function extractRequestId(input: unknown): RequestId {
  if (typeof input === "object" && input !== null && "requestId" in input && typeof input.requestId === "string") {
    return input.requestId.slice(0, 128) as RequestId;
  }
  return `bridge-${randomUUID()}` as RequestId;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1024) : "connection failed";
}
