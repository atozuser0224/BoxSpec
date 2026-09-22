import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { promisify } from "node:util";
import type { GrantId, JsonObject, RequestId } from "@boxspec/shared/domain";
import type { BoxSpecErrorCode, ToolResult } from "@boxspec/shared/errors";
import type { CoreIpcResponse } from "@boxspec/shared/runtime";
import { isAuthenticateFrame, isCancelFrame, parseMcpRequest } from "./protocol.js";
import { persistProfile } from "./profile.js";
import {
  LOCAL_IPC_PROTOCOL_VERSION,
  LocalIpcError,
  TOOL_PERMISSION,
  type IssuePairingProfileInput,
  type LocalIpcHost,
  type LocalIpcHostOptions,
  type McpPairingProfile,
  type SessionBinding,
} from "./types.js";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const MAX_SESSION_LIFETIME_MS = 15 * 60 * 1_000;
const execFileAsync = promisify(execFile);

interface SessionRecord {
  readonly profileName: string;
  readonly binding: SessionBinding;
  readonly sockets: Set<Socket>;
}

export function createLocalIpcHost(options: LocalIpcHostOptions): LocalIpcHost {
  return new NodeLocalIpcHost(options);
}

class NodeLocalIpcHost implements LocalIpcHost {
  readonly pipePath: string;
  readonly #options: LocalIpcHostOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sockets = new Set<Socket>();
  readonly #maxMessageBytes: number;
  readonly #authenticationTimeoutMs: number;
  #server: Server | undefined;

  constructor(options: LocalIpcHostOptions) {
    this.#options = options;
    this.pipePath = options.pipePath ?? `\\\\.\\pipe\\boxspec-${randomUUID()}`;
    if (!/^\\\\\.\\pipe\\boxspec-[A-Za-z0-9-]{1,80}$/u.test(this.pipePath)) {
      throw new LocalIpcError("INVALID_REQUEST", "Invalid BoxSpec named-pipe path");
    }
    this.#maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
    this.#authenticationTimeoutMs = positiveInteger(options.authenticationTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, "authenticationTimeoutMs");
  }

  async start(): Promise<void> {
    if (this.#server) throw new LocalIpcError("INVALID_REQUEST", "Local IPC host is already started");
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.#server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.on("error", (error) => this.#diagnostic("Local IPC listener error", error));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
    if (process.platform === "win32") {
      try {
        await hardenWindowsNamedPipe(this.pipePath);
      } catch (error) {
        await this.close();
        throw new LocalIpcError("INVALID_REQUEST", "Could not restrict the BoxSpec named pipe to the current user", { cause: error });
      }
    }
  }

  async issuePairingProfile(input: IssuePairingProfileInput): Promise<{ readonly profilePath: string; readonly profile: McpPairingProfile }> {
    if (!this.#server?.listening) throw new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC host is not running");
    validateBinding(input, this.#now());
    const sessionToken = randomBytes(32).toString("base64url");
    const digest = tokenDigest(sessionToken);
    const binding: SessionBinding = {
      principalId: input.principalId,
      grantId: input.grantId,
      projectId: input.projectId,
      permissions: [...new Set(input.permissions)],
      expiresAt: input.expiresAt,
    };
    const profile: McpPairingProfile = {
      protocolVersion: LOCAL_IPC_PROTOCOL_VERSION,
      pipePath: this.pipePath,
      sessionToken,
      principalId: binding.principalId,
      grantId: binding.grantId,
      expiresAt: binding.expiresAt,
    };
    for (const [existingDigest, existing] of this.#sessions) {
      if (existing.profileName !== input.profileName) continue;
      this.#sessions.delete(existingDigest);
      for (const socket of existing.sockets) socket.destroy();
    }
    this.#sessions.set(digest, { profileName: input.profileName, binding, sockets: new Set() });
    try {
      return { profilePath: await persistProfile(input.profileName, profile, this.#options.profileRoot), profile };
    } catch (error) {
      this.#sessions.delete(digest);
      throw error;
    }
  }

  revokeGrant(grantId: GrantId): void {
    for (const [digest, session] of this.#sessions) {
      if (session.binding.grantId !== grantId) continue;
      this.#sessions.delete(digest);
      for (const socket of session.sockets) socket.destroy();
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#sessions.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated: SessionRecord | undefined;
    const inflight = new Map<string, AbortController>();
    const timer = setTimeout(() => socket.destroy(), this.#authenticationTimeoutMs);
    timer.unref();

    const clean = (): void => {
      clearTimeout(timer);
      this.#sockets.delete(socket);
      authenticated?.sockets.delete(socket);
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    };
    socket.once("close", clean);
    socket.on("error", (error) => this.#diagnostic("Local IPC connection error", error));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > this.#maxMessageBytes) {
        socket.destroy();
        return;
      }
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) break;
        const line = buffer.slice(0, lineEnd).replace(/\r$/u, "");
        buffer = buffer.slice(lineEnd + 1);
        if (!line || Buffer.byteLength(line, "utf8") > this.#maxMessageBytes) {
          socket.destroy();
          return;
        }
        let frame: unknown;
        try { frame = JSON.parse(line); }
        catch { socket.destroy(); return; }
        if (!authenticated) {
          if (!isAuthenticateFrame(frame)) {
            this.#authenticationRejected(socket);
            return;
          }
          const session = this.#sessions.get(tokenDigest(frame.sessionToken));
          if (!session || Date.parse(session.binding.expiresAt) <= this.#now().getTime()) {
            this.#authenticationRejected(socket);
            return;
          }
          authenticated = session;
          session.sockets.add(socket);
          clearTimeout(timer);
          writeFrame(socket, { type: "authenticated", protocolVersion: LOCAL_IPC_PROTOCOL_VERSION }, this.#maxMessageBytes);
          continue;
        }
        if (isCancelFrame(frame)) {
          inflight.get(frame.requestId)?.abort();
          continue;
        }
        const request = parseMcpRequest(frame);
        if (!request) {
          const requestId = extractUntrustedRequestId(frame);
          if (requestId) writeResponse(socket, failure(requestId, "INVALID_REQUEST", "Invalid local IPC request"), this.#maxMessageBytes);
          else socket.destroy();
          continue;
        }
        if (inflight.has(request.requestId)) {
          writeResponse(socket, failure(request.requestId, "IDEMPOTENCY_CONFLICT", "requestId is already in flight"), this.#maxMessageBytes);
          continue;
        }
        const controller = new AbortController();
        inflight.set(request.requestId, controller);
        void this.#invoke(authenticated, request, controller.signal)
          .then((response) => writeResponse(socket, response, this.#maxMessageBytes))
          .catch(() => writeResponse(socket, failure(request.requestId, "INTERNAL_ERROR", "Local IPC request failed"), this.#maxMessageBytes))
          .finally(() => inflight.delete(request.requestId));
      }
    });
  }

  async #invoke(
    session: SessionRecord,
    request: NonNullable<ReturnType<typeof parseMcpRequest>>,
    signal: AbortSignal,
  ): Promise<CoreIpcResponse> {
    const binding = session.binding;
    if (Date.parse(binding.expiresAt) <= this.#now().getTime()) {
      return failure(request.requestId, "PROJECT_NOT_GRANTED", "Pairing session expired");
    }
    if (!binding.permissions.includes(TOOL_PERMISSION[request.tool])) {
      return failure(request.requestId, "PROJECT_NOT_GRANTED", "Grant lacks the required permission");
    }
    if (isProjectPayload(request.payload) && request.payload.projectId !== binding.projectId) {
      return failure(request.requestId, "PROJECT_NOT_GRANTED", "Request is outside the paired project");
    }
    try {
      await this.#options.authorizeSession(binding, request.tool, request.payload, signal);
    } catch {
      return failure(request.requestId, "PROJECT_NOT_GRANTED", "Project grant is unavailable, expired, or revoked");
    }
    const principal = { kind: "mcp-client" as const, principalId: binding.principalId, grantId: binding.grantId };
    const result = await this.#options.mcp.invoke(principal, request.tool, request.payload, signal);
    return { protocolVersion: LOCAL_IPC_PROTOCOL_VERSION, requestId: request.requestId, result };
  }

  #authenticationRejected(socket: Socket): void {
    writeFrame(socket, { type: "authentication_error", protocolVersion: LOCAL_IPC_PROTOCOL_VERSION, code: "PAIRING_REQUIRED" }, this.#maxMessageBytes);
    socket.end();
  }

  #now(): Date { return this.#options.clock?.() ?? new Date(); }

  #diagnostic(message: string, error?: unknown): void {
    this.#options.diagnostic?.(message, error instanceof Error ? new Error(error.message) : undefined);
  }
}

function validateBinding(input: IssuePairingProfileInput, now: Date): void {
  if (!input.principalId || input.principalId.length > 256 || !input.grantId || !input.projectId) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing binding is incomplete");
  }
  if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now.getTime()) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing expiry must be in the future");
  }
  if (Date.parse(input.expiresAt) - now.getTime() > MAX_SESSION_LIFETIME_MS) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing expiry exceeds the 15-minute session limit");
  }
  if (input.permissions.length === 0 || input.permissions.some((permission) => !["read", "candidate-write", "verify"].includes(permission))) {
    throw new LocalIpcError("INVALID_REQUEST", "Pairing permissions are invalid");
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function writeResponse(socket: Socket, response: CoreIpcResponse, maxBytes: number): void {
  writeFrame(socket, response, maxBytes);
}

function writeFrame(socket: Socket, frame: unknown, maxBytes: number): void {
  if (socket.destroyed) return;
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    socket.destroy();
    return;
  }
  socket.write(encoded);
}

function failure(requestId: RequestId, code: BoxSpecErrorCode, message: string): CoreIpcResponse {
  const result: ToolResult<unknown> = { ok: false, code, message, recoverable: false, requestId };
  return { protocolVersion: LOCAL_IPC_PROTOCOL_VERSION, requestId, result };
}

function extractUntrustedRequestId(value: unknown): RequestId | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128 && !/[\r\n\0]/u.test(requestId)
    ? requestId as RequestId
    : null;
}

function isProjectPayload(value: unknown): value is { readonly projectId: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).projectId === "string";
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new LocalIpcError("INVALID_REQUEST", `${name} must be a positive integer`);
  return resolved;
}

async function hardenWindowsNamedPipe(pipePath: string): Promise<void> {
  const pipeName = pipePath.slice("\\\\.\\pipe\\".length);
  const environment = { ...process.env, BOXSPEC_PIPE_ACL_NAME: pipeName };
  const setAcl = [
    "$p=[System.IO.Pipes.NamedPipeClientStream]::new(\".\",$env:BOXSPEC_PIPE_ACL_NAME,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.IO.Pipes.PipeOptions]::None,[System.Security.Principal.TokenImpersonationLevel]::Impersonation,[System.IO.HandleInheritability]::None)",
    "$p.Connect(2000)",
    "try {",
    "$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$s=New-Object System.IO.Pipes.PipeSecurity",
    "$s.SetAccessRuleProtection($true,$false)",
    "$network=New-Object System.Security.Principal.SecurityIdentifier(\"S-1-5-2\")",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($network,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Deny)))",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($u,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)))",
    "$sys=New-Object System.Security.Principal.SecurityIdentifier(\"S-1-5-18\")",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sys,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)))",
    "$p.SetAccessControl($s)",
    "$u.Value",
    "} finally { $p.Dispose() }",
  ].join("\n");
  const applied = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", setAcl], {
    windowsHide: true,
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
  });

  const inspectAcl = [
    "$p=New-Object System.IO.Pipes.NamedPipeClientStream(\".\",$env:BOXSPEC_PIPE_ACL_NAME,[System.IO.Pipes.PipeDirection]::InOut)",
    "$p.Connect(2000)",
    "try { $p.GetAccessControl().GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) } finally { $p.Dispose() }",
  ].join("\n");
  const inspected = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspectAcl], {
    windowsHide: true,
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
  });
  const sddl = inspected.stdout.trim();
  const currentSid = /S-1-[0-9-]+/u.exec(applied.stdout)?.[0];
  if (!currentSid || !sddl.startsWith("D:P") || !sddl.includes(`;;;${currentSid})`) || !sddl.includes(";;;SY)") || !/\(D;[^)]*;;;NU\)/u.test(sddl)) {
    throw new Error("Named-pipe DACL did not bind the current user and SYSTEM or deny network logons");
  }
  if (/;;;(?:WD|AN|AU|BU|BA)\)/u.test(sddl)) {
    throw new Error("Named-pipe DACL retained a broad access rule");
  }
}
