import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createChangeManager } from "@boxspec/change-manager";
import { createLocalIpcHost } from "@boxspec/local-ipc";
import { BoxSpecApplicationRuntime } from "@boxspec/runtime";

const execFile = promisify(execFileCallback);
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const opencodeExecutable = process.env.APPDATA === undefined
  ? "opencode"
  : join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
const temporaryRoot = await mkdtemp(join(tmpdir(), "boxspec-opencode-cli-"));
const projectRoot = join(temporaryRoot, "project");
const profileRoot = join(temporaryRoot, "profiles");
const changeManager = createChangeManager({ stateRoot: join(temporaryRoot, "change-manager") });
let counter = 0;
const runtime = await BoxSpecApplicationRuntime.open({
  dataDir: join(temporaryRoot, "data"),
  changeManager,
  verifyCandidate: async () => { throw new Error("verification is outside this read-only probe"); },
  idGenerator: (prefix) => `${prefix}_opencode_${++counter}`,
  allowedWritePaths: ["src/boxspec/"],
  protectedPaths: ["package.json", ".git/"]
});
const host = createLocalIpcHost({
  mcp: runtime.mcp,
  profileRoot,
  authorizeSession: runtime.authorizeMcpSession.bind(runtime)
});

try {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "package.json"), '{"name":"opencode-cli-bridge-evidence","private":true}\n', "utf8");
  await writeFile(join(projectRoot, "src", "main.tsx"), "export const Main = () => null;\n", "utf8");
  await execFile("git", ["init"], { cwd: projectRoot });
  await execFile("git", ["config", "user.email", "boxspec-evidence@example.invalid"], { cwd: projectRoot });
  await execFile("git", ["config", "user.name", "BoxSpec Evidence"], { cwd: projectRoot });
  await execFile("git", ["add", "."], { cwd: projectRoot });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: projectRoot });

  const project = await runtime.desktop.createProject({ name: "OpenCode CLI Evidence", rootPath: projectRoot, target: "web-react" });
  const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "CLI Dashboard", width: 1440, height: 900 });
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const grant = await runtime.desktop.pairMcpClient({
    projectId: project.projectId,
    principalId: "opencode-cli-client",
    permissions: ["read"],
    expiresAt
  });
  await host.start();
  await host.issuePairingProfile({
    profileName: "opencode-cli",
    principalId: grant.principalId,
    grantId: grant.grantId,
    projectId: project.projectId,
    permissions: grant.permissions,
    expiresAt: grant.expiresAt
  });

  const launcher = resolve(workspaceRoot, "apps/mcp/dist/index.js");
  const configPath = join(projectRoot, "opencode.json");
  await writeFile(configPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    permission: {
      "*": "deny",
      boxspec_boxspec_get_capabilities: "allow",
      boxspec_boxspec_get_context: "allow"
    },
    mcp: {
      boxspec: {
        type: "local",
        command: [process.execPath, launcher, "--profile", "opencode-cli"],
        enabled: true,
        environment: { BOXSPEC_MCP_PROFILE_ROOT: profileRoot },
        timeout: 30_000
      }
    }
  }, null, 2) + "\n", "utf8");

  const prompt = [
    "Use only the BoxSpec MCP tools. Do not run shell commands, read files, browse, or modify anything.",
    "Call boxspec_get_capabilities once.",
    `Then call boxspec_get_context once with projectId ${project.projectId}, screenId ${screen.screenId}, expectedRevision ${screen.revision}, and nodeIds [\"main\"].`,
    "Return one short line containing the capability serverVersion, the context projectId, and revision."
  ].join(" ");
  const { stdout, stderr } = await runOpenCode([
    "run",
    "--pure",
    "--model", "opencode/gpt-5.6-sol",
    "--variant", "high",
    "--format", "json",
    "--dir", projectRoot,
    prompt
  ], {
    cwd: projectRoot,
    timeoutMs: 120_000,
    env: { ...process.env, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "true" }
  });
  const serialized = stdout;
  assert.match(serialized, /boxspec_get_capabilities/);
  assert.match(serialized, /boxspec_get_context/);
  assert.match(serialized, new RegExp(project.projectId));
  assert.match(serialized, new RegExp(`revision[^0-9]*${screen.revision}`));
  assert.equal(stderr.includes("sessionToken"), false);
  process.stdout.write(JSON.stringify({
    ok: true,
    model: "opencode/gpt-5.6-sol",
    variant: "high",
    permissions: "deny-all-except-two-boxspec-reads",
    projectId: project.projectId,
    revision: screen.revision,
    outputLines: stdout.split(/\r?\n/).filter(Boolean).length
  }) + "\n");
} finally {
  await host.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runOpenCode(args, { cwd, timeoutMs, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opencodeExecutable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`OpenCode CLI exited ${String(code)} (${String(signal)}): ${stderr.slice(0, 4096)}`));
      }
    });
  });
}
