import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerRoot = dirname(fileURLToPath(import.meta.url));
const toolchainRoot = resolve(runnerRoot, "../toolchain/node_modules");
const outputDirectory = process.argv[2];
const outputPath = outputDirectory ? resolve(outputDirectory) : "";
const outputRelativeToCandidate = outputPath ? relative(process.cwd(), outputPath) : "";
if (!outputDirectory || !isAbsolute(outputDirectory) || outputRelativeToCandidate === "" || (!outputRelativeToCandidate.startsWith(`..${sep}`) && outputRelativeToCandidate !== "..")) {
  throw new Error("A verifier-owned absolute output directory is required");
}
const tsconfigPath = join(outputPath, "boxspec-tsconfig.json");
await mkdir(outputPath, { recursive: true });
await writeFile(tsconfigPath, JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, noUncheckedIndexedAccess: true, noUncheckedSideEffectImports: true,
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx",
    allowJs: false, skipLibCheck: true, lib: ["ES2022", "DOM", "DOM.Iterable"],
    baseUrl: process.cwd(),
    paths: {
      react: [join(toolchainRoot, "@types/react/index.d.ts")], "react/*": [join(toolchainRoot, "@types/react/*")],
      "react-dom": [join(toolchainRoot, "@types/react-dom/index.d.ts")], "react-dom/*": [join(toolchainRoot, "@types/react-dom/*")],
      "vite/client": [join(toolchainRoot, "vite/client.d.ts")],
    },
    typeRoots: [join(toolchainRoot, "@types")], types: ["react", "react-dom", "vite/client"],
  },
  include: [join(process.cwd(), "src/**/*")],
  exclude: [join(process.cwd(), "node_modules"), join(process.cwd(), "dist")],
}, null, 2));
const tsc = join(toolchainRoot, "typescript/lib/tsc.js");
process.argv = [process.execPath, tsc, "--project", tsconfigPath, "--noEmit"];
await import(pathToFileURL(tsc).href);
