import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const installer = join(repositoryRoot, "apps", "desktop", "node_modules", "electron", "install.js");

// Production-only staging intentionally omits Electron's development package.
if (existsSync(installer)) {
  const result = spawnSync(process.execPath, [installer], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
