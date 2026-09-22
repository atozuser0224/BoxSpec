import { createConnection, type Socket } from "node:net";
import type { RequestId } from "@boxspec/shared/domain";
import type { CoreIpcClient, CoreIpcRequest, CoreIpcResponse } from "@boxspec/shared/runtime";
import { isAuthenticatedFrame, isAuthenticationErrorFrame, isCoreIpcResponse } from "./protocol.js";
import { loadProfile } from "./profile.js";
import {
  LOCAL_IPC_PROTOCOL_VERSION,
  LocalIpcError,
  type ProfileCoreIpcClientOptions,
  type ProfileCoreIpcConnection,
} from "./types.js";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

interface PendingRequest {
  readonly resolve: (response: CoreIpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly abortCleanup: () => void;
}

export async function createProfileCoreIpcClient(options: ProfileCoreIpcClientOptions): Promise<ProfileCoreIpcConnection> {
  const profile = await loadProfile(options.profileName, options.profileRoot);
  const maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
  const connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
  const socket = createConnection(profile.pipePath);
  socket.setEncoding("utf8");

  const client = new NamedPipeCoreIpcClient(socket, maxMessageBytes);
  try {
    await client.authenticate(profile.sessionToken, connectTimeoutMs);
  } catch (error) {
    socket.destroy();
    throw classifyConnectError(error);
  }
  const principal = { kind: "mcp-client" as const, principalId: profile.principalId, grantId: profile.grantId };
  return { client, principal, close: () => client.close() };
}

class NamedPipeCoreIpcClient implements CoreIpcClient {
  readonly #socket: Socket;
  readonly #maxMessageBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  #buffer = "";
  #authenticated = false;
  #closed = false;
  #authResolve: (() => void) | undefined;
  #authReject: ((error: Error) => void) | undefined;

  constructor(socket: Socket, maxMessageBytes: number) {
    this.#socket = socket;
    this.#maxMessageBytes = maxMessageBytes;
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC connection closed")));
  }

  async authenticate(sessionToken: string, timeoutMs: number): Promise<void> {
    if (this.#authenticated || this.#closed || this.#authResolve) {
      throw new LocalIpcError("INVALID_REQUEST", "Local IPC client cannot authenticate in its current state");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#authResolve = undefined;
        this.#authReject = undefined;
        reject(new LocalIpcError("APP_NOT_RUNNING", "Timed out connecting to the BoxSpec app"));
      }, timeoutMs);
      timer.unref();
      this.#authResolve = () => { clearTimeout(timer); this.#authResolve = undefined; this.#authReject = undefined; resolve(); };
      this.#authReject = (error) => { clearTimeout(timer); this.#authResolve = undefined; this.#authReject = undefined; reject(error); };
      const writeAuthentication = (): void => {
        try {
          this.#write({ type: "authenticate", protocolVersion: LOCAL_IPC_PROTOCOL_VERSION, sessionToken });
        } catch (error) {
          this.#authReject?.(asError(error));
        }
      };
      if (this.#socket.readyState === "open") writeAuthentication();
      else this.#socket.once("connect", writeAuthentication);
    });
  }

  invoke(request: CoreIpcRequest, signal?: AbortSignal): Promise<CoreIpcResponse> {
    if (!this.#authenticated || this.#closed) {
      return Promise.reject(new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC connection is unavailable"));
    }
    if (request.channel !== "mcp") {
      return Promise.reject(new LocalIpcError("INVALID_REQUEST", "The MCP connection cannot invoke desktop operations"));
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.reject(new LocalIpcError("INVALID_REQUEST", "requestId is already in flight"));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<CoreIpcResponse>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(request.requestId);
        try { this.#write({ type: "cancel", protocolVersion: LOCAL_IPC_PROTOCOL_VERSION, requestId: request.requestId }); }
        catch { /* The connection failure path rejects any remaining request. */ }
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const abortCleanup = (): void => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(request.requestId, { resolve, reject, abortCleanup });
      try {
        this.#write(request);
      } catch (error) {
        this.#pending.delete(request.requestId);
        abortCleanup();
        reject(asError(error));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.abortCleanup();
      pending.reject(new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC connection closed"));
    }
    this.#pending.clear();
    await new Promise<void>((resolve) => {
      if (this.#socket.destroyed) { resolve(); return; }
      this.#socket.once("close", () => resolve());
      this.#socket.end();
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxMessageBytes) {
      this.#fail(new LocalIpcError("RESOURCE_LIMIT", "Local IPC response exceeded the size limit"));
      this.#socket.destroy();
      return;
    }
    for (;;) {
      const lineEnd = this.#buffer.indexOf("\n");
      if (lineEnd < 0) break;
      const line = this.#buffer.slice(0, lineEnd).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (!line || Buffer.byteLength(line, "utf8") > this.#maxMessageBytes) {
        this.#fail(new LocalIpcError("RESOURCE_LIMIT", "Local IPC response exceeded the size limit"));
        this.#socket.destroy();
        return;
      }
      let frame: unknown;
      try { frame = JSON.parse(line); }
      catch {
        this.#fail(new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC returned invalid data"));
        this.#socket.destroy();
        return;
      }
      if (!this.#authenticated) {
        if (isAuthenticatedFrame(frame)) {
          this.#authenticated = true;
          this.#authResolve?.();
        } else if (isAuthenticationErrorFrame(frame)) {
          this.#authReject?.(new LocalIpcError("PAIRING_REQUIRED", "BoxSpec pairing was rejected"));
        } else {
          this.#authReject?.(new LocalIpcError("PAIRING_REQUIRED", "BoxSpec authentication response was invalid"));
        }
        continue;
      }
      if (!isCoreIpcResponse(frame)) {
        this.#fail(new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC returned an invalid response"));
        this.#socket.destroy();
        return;
      }
      const pending = this.#pending.get(frame.requestId);
      if (!pending) continue;
      this.#pending.delete(frame.requestId);
      pending.abortCleanup();
      pending.resolve(frame);
    }
  }

  #write(frame: unknown): void {
    if (this.#closed || this.#socket.destroyed) throw new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC connection is unavailable");
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.#maxMessageBytes) {
      throw new LocalIpcError("RESOURCE_LIMIT", "Local IPC request exceeded the size limit");
    }
    this.#socket.write(encoded);
  }

  #fail(error: Error): void {
    const classified = error instanceof LocalIpcError
      ? error
      : new LocalIpcError("APP_NOT_RUNNING", "BoxSpec local IPC connection failed", { cause: error });
    if (!this.#authenticated) this.#authReject?.(classified);
    for (const pending of this.#pending.values()) {
      pending.abortCleanup();
      pending.reject(classified);
    }
    this.#pending.clear();
  }
}

function classifyConnectError(error: unknown): LocalIpcError {
  if (error instanceof LocalIpcError) return error;
  return new LocalIpcError("APP_NOT_RUNNING", "Could not connect to the BoxSpec app", { cause: error });
}

function abortError(): Error {
  const error = new Error("The local IPC request was cancelled");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown local IPC failure");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new LocalIpcError("INVALID_REQUEST", `${name} must be a positive integer`);
  return resolved;
}
