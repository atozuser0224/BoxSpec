import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface CommandResult {
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

const MAX_OUTPUT_BYTES = 16_384;

export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return await isExecutableFile(command) ? path.resolve(command) : null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = path.extname(command).length > 0;
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${command}${extension}`);
      if (await isExecutableFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let started = false;
    let timedOut = false;
    const invocation = windowsCommandInvocation(command, args, options.env ?? process.env);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: Omit<CommandResult, "stdout" | "stderr" | "started" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ started, timedOut, stdout: trimOutput(stdout), stderr: trimOutput(stderr), ...result });
    };
    child.once("spawn", () => { started = true; });
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => finish({ exitCode: null, error: error.message }));
    child.once("close", (code) => finish({ exitCode: code }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 5_000);
    timer.unref();
  });
}

function windowsCommandInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv): { command: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args: [...args], verbatim: false };
  const commandProcessor = env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
  const quote = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;
  return { command: commandProcessor, args: ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], verbatim: true };
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function appendBounded(existing: string, chunk: Buffer): string {
  if (Buffer.byteLength(existing, "utf8") >= MAX_OUTPUT_BYTES) return existing;
  return (existing + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function trimOutput(output: string): string {
  return output.trim().slice(0, MAX_OUTPUT_BYTES);
}
