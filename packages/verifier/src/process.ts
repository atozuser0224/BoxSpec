import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { resolveInside } from "./hash.js";
import { sha256Bytes } from "./hash.js";
import type { ExplicitCommand } from "./types.js";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

function trustedBaseEnvironment(): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", TZ: "UTC", LANG: "C.UTF-8" };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function terminateProcessTree(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false, env: trustedBaseEnvironment() });
    killer.once("error", () => child.kill("SIGKILL"));
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export async function runExplicitCommand(
  command: ExplicitCommand,
  candidateRoot: string,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted) throw new DOMException("Verification command aborted before spawn", "AbortError");
  if (!isAbsolute(command.executable)) throw new Error("Execution profile executable must be absolute");
  for (const name of Object.keys(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase() === "NODE_OPTIONS") {
      throw new Error(`Execution profile contains a forbidden environment variable: ${name}`);
    }
  }
  if (sha256Bytes(await readFile(command.executable)) !== command.executableSha256) {
    throw new Error("Execution profile executable hash does not match the approved binary");
  }
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 15 * 60_000) {
    throw new Error("Execution profile timeout must be between 1ms and 15 minutes");
  }
  const cwd = command.cwd === "." ? candidateRoot : resolveInside(candidateRoot, command.cwd);
  const args = command.args.map((arg) => arg.replaceAll("{outputDir}", outputDirectory));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, args, {
      cwd,
      env: { ...trustedBaseEnvironment(), ...(command.env ?? {}) },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    const append = (current: string, chunk: string): string => {
      if (outputLimitExceeded) return current;
      const nextBytes = Buffer.byteLength(current) + Buffer.byteLength(chunk);
      if (nextBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminateProcessTree(child);
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(current));
        return `${current}${Buffer.from(chunk).subarray(0, remaining).toString("utf8")}\n[output truncated: verifier limit exceeded]\n`;
      }
      return current + chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = append(stdout, chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = append(stderr, chunk)));
    const terminate = () => terminateProcessTree(child);
    signal?.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, command.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      resolve({ exitCode, stdout, stderr, timedOut, outputLimitExceeded, durationMs: Date.now() - started });
    });
  });
}
