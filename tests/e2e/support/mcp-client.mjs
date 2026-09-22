import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [requestPath, resultPath] = process.argv.slice(2);
if (!requestPath || !resultPath) throw new Error("Usage: mcp-client.mjs REQUEST RESULT");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromMcp = createRequire(join(repositoryRoot, "apps", "mcp", "package.json"));
const clientModule = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/client")).href);
const stdioModule = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/client/stdio")).href);
const request = JSON.parse(await readFile(requestPath, "utf8"));
const launcher = join(repositoryRoot, "apps", "mcp", "dist", "index.js");
const launcherCommand = request.launcherCommand ?? process.execPath;
const launcherArgs = [...(request.launcherArgs ?? [launcher]), "--profile", request.profileName];
let launcherStderr = "";
const transport = new stdioModule.StdioClientTransport({
  command: launcherCommand,
  args: launcherArgs,
  cwd: request.launcherCwd ?? repositoryRoot,
  env: { ...stdioModule.getDefaultEnvironment(), BOXSPEC_MCP_PROFILE_ROOT: process.env.BOXSPEC_MCP_PROFILE_ROOT },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => { launcherStderr += chunk.toString("utf8"); });
const client = new clientModule.Client(
  { name: "boxspec-electron-e2e", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  await client.connect(transport);
  const result = await client.callTool({ name: request.tool, arguments: request.args });
  await writeFile(resultPath, `${JSON.stringify({ result, launcherStderr }, null, 2)}\n`, "utf8");
} finally {
  await client.close().catch(() => undefined);
}
