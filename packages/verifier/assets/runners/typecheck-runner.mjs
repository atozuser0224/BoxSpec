import { mkdir, readdir, writeFile } from "node:fs/promises";
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
const sourceFiles = [];
async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) throw new Error("Linked candidate sources are unsupported");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(path);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) sourceFiles.push(path);
    if (sourceFiles.length > 10000) throw new Error("Candidate source limit exceeded");
  }
}
await collectSourceFiles(join(process.cwd(), "src"));
if (sourceFiles.length === 0) throw new Error("No TypeScript candidate sources found");
await mkdir(outputPath, { recursive: true });
await writeFile(tsconfigPath, JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, noUncheckedIndexedAccess: true, noUncheckedSideEffectImports: true,
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx",
    allowJs: false, skipLibCheck: true, lib: ["ES2022", "DOM", "DOM.Iterable"],
    paths: {
      react: [join(toolchainRoot, "@types/react/index.d.ts")], "react/*": [join(toolchainRoot, "@types/react/*")],
      "react-dom": [join(toolchainRoot, "@types/react-dom/index.d.ts")], "react-dom/*": [join(toolchainRoot, "@types/react-dom/*")],
      "vite/client": [join(toolchainRoot, "vite/client.d.ts")],
    },
    typeRoots: [join(toolchainRoot, "@types"), toolchainRoot], types: ["react", "react-dom"],
  },
  files: sourceFiles,
}, null, 2));
const tsc = join(toolchainRoot, "typescript/lib/tsc.js");
process.argv = [process.execPath, tsc, "--project", tsconfigPath, "--noEmit"];
await import(pathToFileURL(tsc).href);
