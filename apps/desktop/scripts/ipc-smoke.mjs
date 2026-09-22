import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLocalIpcHost, createProfileCoreIpcClient } from "@boxspec/local-ipc";
import { createBoxSpecRuntime } from "@boxspec/runtime";

const run = promisify(execFile);
const dataDir = await mkdtemp(join(tmpdir(), "boxspec-ipc-state-"));
const rootPath = await mkdtemp(join(tmpdir(), "boxspec-ipc-project-"));
const profileRoot = await mkdtemp(join(tmpdir(), "boxspec-ipc-profile-"));

await run("git", ["init"], { cwd: rootPath });
await run("git", ["config", "user.email", "smoke@example.invalid"], { cwd: rootPath });
await run("git", ["config", "user.name", "BoxSpec Smoke"], { cwd: rootPath });
await writeFile(join(rootPath, "README.md"), "BoxSpec authenticated IPC smoke\n");
await run("git", ["add", "README.md"], { cwd: rootPath });
await run("git", ["commit", "-m", "IPC smoke fixture"], { cwd: rootPath });

const runtime = await createBoxSpecRuntime({ dataDir });
const project = await runtime.desktop.createProject({ name: "IPC smoke", rootPath, target: "web-react" });
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const grant = await runtime.desktop.pairMcpClient({
  projectId: project.projectId,
  principalId: "smoke-client",
  permissions: ["read", "candidate-write", "verify"],
  expiresAt,
});
const host = createLocalIpcHost({
  mcp: runtime.mcp,
  profileRoot,
  authorizeSession: (binding, tool, payload, signal) => runtime.authorizeMcpSession(binding, tool, payload, signal),
});

try {
  await host.start();
  await host.issuePairingProfile({
    profileName: project.projectId,
    principalId: "smoke-client",
    grantId: grant.grantId,
    projectId: project.projectId,
    permissions: grant.permissions,
    expiresAt,
  });
  const connection = await createProfileCoreIpcClient({ profileName: project.projectId, profileRoot });
  try {
    const response = await connection.client.invoke({
      protocolVersion: "1.0.0",
      channel: "mcp",
      requestId: "desktop-ipc-smoke",
      tool: "boxspec_get_capabilities",
      payload: {},
    });
    if (!response.result.ok) throw new Error(`Capabilities call failed: ${response.result.code}`);
    process.stdout.write(`${JSON.stringify({ ok: true, pipePath: host.pipePath, principalId: connection.principal.principalId })}\n`);
  } finally {
    await connection.close();
  }
} finally {
  await host.close();
  await runtime.close();
}
