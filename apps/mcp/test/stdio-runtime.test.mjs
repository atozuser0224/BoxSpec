import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { createChangeManager } from "@boxspec/change-manager";
import { createLocalIpcHost } from "@boxspec/local-ipc";
import { BoxSpecApplicationRuntime } from "@boxspec/runtime";

const execFile = promisify(execFileCallback);
const workspaceRoot = resolve(import.meta.dirname, "../../..");

test("official external SDK client reads real runtime context over stdio and authenticated IPC", { timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "boxspec-mcp-e2e-"));
  const projectRoot = join(temporaryRoot, "project");
  const dataRoot = join(temporaryRoot, "data");
  const profileRoot = join(temporaryRoot, "profiles");
  const changeManager = createChangeManager({ stateRoot: join(temporaryRoot, "change-manager") });
  let counter = 0;
  const runtime = await BoxSpecApplicationRuntime.open({
    dataDir: dataRoot,
    changeManager,
    verifyCandidate: async () => { throw new Error("verification is not used by this context-read test"); },
    idGenerator: (prefix) => `${prefix}_test_${++counter}`,
    allowedWritePaths: ["src/boxspec/"],
    protectedPaths: ["package.json", ".git/"]
  });
  const host = createLocalIpcHost({
    mcp: runtime.mcp,
    profileRoot,
    authorizeSession: runtime.authorizeMcpSession.bind(runtime)
  });
  let client;
  let stderr = "";
  t.after(async () => {
    if (stderr) t.diagnostic(`MCP launcher stderr: ${stderr}`);
    await client?.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "package.json"), '{"name":"bridge-evidence","private":true}\n', "utf8");
  await writeFile(join(projectRoot, "src", "main.tsx"), "export const Main = () => null;\n", "utf8");
  await execFile("git", ["init"], { cwd: projectRoot });
  await execFile("git", ["config", "user.email", "boxspec-evidence@example.invalid"], { cwd: projectRoot });
  await execFile("git", ["config", "user.name", "BoxSpec Evidence"], { cwd: projectRoot });
  await execFile("git", ["add", "."], { cwd: projectRoot });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: projectRoot });

  const project = await runtime.desktop.createProject({ name: "Bridge Evidence", rootPath: projectRoot, target: "web-react" });
  const screen = await runtime.desktop.createScreen({ projectId: project.projectId, name: "Dashboard", width: 1440, height: 900 });
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const grant = await runtime.desktop.pairMcpClient({
    projectId: project.projectId,
    principalId: "sdk-external-client",
    permissions: ["read"],
    expiresAt
  });
  await host.start();
  await host.issuePairingProfile({
    profileName: "integration",
    principalId: grant.principalId,
    grantId: grant.grantId,
    projectId: project.projectId,
    permissions: grant.permissions,
    expiresAt: grant.expiresAt
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(workspaceRoot, "apps/mcp/dist/index.js"), "--profile", "integration"],
    cwd: workspaceRoot,
    env: { ...getDefaultEnvironment(), BOXSPEC_MCP_PROFILE_ROOT: profileRoot },
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  client = new Client(
    { name: "boxspec-external-sdk-evidence", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(transport);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 15);
  assert.equal(listed.tools.some((tool) => ["approve", "unlock", "apply_to_main", "run_shell", "read_secret"].includes(tool.name)), false);

  const contextInput = {
    projectId: project.projectId,
    screenId: screen.screenId,
    expectedRevision: screen.revision,
    nodeIds: ["main"]
  };
  const context = await client.callTool({ name: "boxspec_get_context", arguments: contextInput });
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.ok, true);
  assert.equal(context.structuredContent.data.projectId, project.projectId);
  assert.equal(context.structuredContent.data.revision, screen.revision);
  assert.deepEqual(context.structuredContent.data.scopeNodeIds, ["main"]);
  assert.doesNotThrow(() => JSON.parse(context.structuredContent.data.contractSliceJson));

  const resource = await client.readResource({
    uri: `boxspec://projects/${project.projectId}/screens/${screen.screenId}?revision=${screen.revision}&nodeIds=main`
  });
  assert.equal(resource.contents.length, 1);
  assert.equal(JSON.parse(resource.contents[0].text).ok, true);

  const foreign = await client.callTool({
    name: "boxspec_get_context",
    arguments: { ...contextInput, projectId: "prj_foreign" }
  });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.code, "PROJECT_NOT_GRANTED");

  const stale = await client.callTool({
    name: "boxspec_get_context",
    arguments: { ...contextInput, expectedRevision: screen.revision + 1 }
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.code, "REVISION_CONFLICT");

  const invalid = await client.callTool({
    name: "boxspec_get_context",
    arguments: { ...contextInput, unexpected: true }
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /INVALID_REQUEST|validation/i);
  assert.equal(stderr.includes("sessionToken"), false);
});
