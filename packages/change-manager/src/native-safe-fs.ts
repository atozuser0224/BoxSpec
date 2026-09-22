import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { sha256 } from "./hash.js";
import { ChangeManagerError } from "./types.js";

export interface NativeRootIdentity {
  readonly canonicalPath: string;
  readonly volumeId: string;
  readonly fileId: string;
}

export interface NativeEntryIdentity {
  readonly volumeId: string;
  readonly fileId: string;
}

export interface EnsuredDirectory {
  readonly finalPath: string;
  readonly identity: NativeEntryIdentity;
  readonly created: readonly string[];
}

interface NativeResponse<Result> {
  readonly ok: boolean;
  readonly requestId: string;
  readonly result?: Result;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export interface PreparedReplacement {
  readonly preparedId: string;
  readonly disposition: "create" | "delete" | "replace";
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly backupHash: string | null;
}

export interface RecoveryClassification {
  readonly state: "BEFORE" | "AFTER" | "UNKNOWN";
  readonly reason: string | null;
  readonly canRestoreBefore: boolean;
  readonly canFinishAfter: boolean;
}

export class NativeSafeFsClient {
  constructor(
    private readonly binaryPath: string,
    private readonly expectedSha256: string,
  ) {}

  async verifyExecutable(): Promise<void> {
    const actual = sha256(await readFile(this.binaryPath));
    if (actual !== this.expectedSha256) {
      throw new ChangeManagerError("UNSUPPORTED_CAPABILITY", "Native safe-filesystem executable hash mismatch", false, {
        expected: this.expectedSha256,
        actual,
      });
    }
  }

  async inspectRoot(root: string): Promise<NativeRootIdentity> {
    const result = await this.call<{ rootIdentity: NativeRootIdentity }>({ op: "inspect_root", root });
    return result.rootIdentity;
  }

  async ensureDirectory(input: {
    root: string;
    rootIdentity: NativeRootIdentity;
    relativePath: string;
  }): Promise<EnsuredDirectory> {
    return this.call({ op: "ensure_directory", ...input });
  }

  async prepareReplace(input: {
    transactionId: string;
    root: string;
    rootIdentity: NativeRootIdentity;
    relativePath: string;
    expectedBeforeHash: string | null;
    afterBytes: Buffer | null;
  }): Promise<PreparedReplacement> {
    return this.call({
      op: "prepare_replace",
      transactionId: input.transactionId,
      root: input.root,
      rootIdentity: input.rootIdentity,
      relativePath: input.relativePath,
      expectedBeforeHash: input.expectedBeforeHash,
      expectedBeforeFileId: null,
      afterBytesBase64: input.afterBytes?.toString("base64") ?? null,
    });
  }

  async commitReplace(input: NativeBoundPrepared): Promise<{ afterHash: string | null }> {
    return this.call({ op: "commit_replace", ...input });
  }

  async classifyRecovery(input: NativeBoundPrepared & { beforeHash: string | null; afterHash: string | null }): Promise<RecoveryClassification> {
    return this.call({ op: "classify_recovery", ...input });
  }

  async recoverReplace(input: NativeBoundPrepared & { decision: "restore_before" | "finish_after" }): Promise<{ state: "BEFORE" | "AFTER"; changed: boolean }> {
    return this.call({ op: "recover_replace", ...input });
  }

  async finalizeReplace(input: NativeBoundPrepared): Promise<{ finalized: boolean }> {
    return this.call({ op: "finalize_replace", ...input });
  }

  private async call<Result>(request: Readonly<Record<string, unknown>>): Promise<Result> {
    await this.verifyExecutable();
    const requestId = `native_${randomUUID().replaceAll("-", "")}`;
    const payload = Buffer.from(JSON.stringify({ requestId, ...request }), "utf8");
    if (payload.byteLength > 24 * 1024 * 1024) {
      throw new ChangeManagerError("INVALID_REQUEST", "Native safe-filesystem request exceeds protocol limit", false);
    }
    const response = await new Promise<NativeResponse<Result>>((resolve, reject) => {
      const child = spawn(this.binaryPath, ["--protocol", "1"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 2 * 1024 * 1024) child.kill();
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new ChangeManagerError("UNSUPPORTED_CAPABILITY", "Native safe-filesystem process failed", true, {
              exitCode: code,
              stderr: Buffer.concat(stderr).toString("utf8").slice(0, 4096),
            }),
          );
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as NativeResponse<Result>);
        } catch {
          reject(new ChangeManagerError("INTERNAL_ERROR", "Native safe-filesystem returned invalid JSON", false));
        }
      });
      child.stdin.end(payload);
    });
    if (response.requestId !== requestId) {
      throw new ChangeManagerError("INTERNAL_ERROR", "Native safe-filesystem response requestId mismatch", false);
    }
    if (!response.ok || response.result === undefined) {
      const native = response.error;
      const code = native?.code === "SOURCE_DRIFT" || native?.code === "UNKNOWN_STATE" ? "APPLY_CONFLICT" : "PROTECTED_PATH";
      throw new ChangeManagerError(code, native?.message ?? "Native safe-filesystem operation failed", native?.retryable ?? false, {
        nativeCode: native?.code ?? "UNKNOWN",
      });
    }
    return response.result;
  }
}

export interface NativeBoundPrepared {
  readonly transactionId: string;
  readonly root: string;
  readonly rootIdentity: NativeRootIdentity;
  readonly relativePath: string;
  readonly preparedId: string;
}
