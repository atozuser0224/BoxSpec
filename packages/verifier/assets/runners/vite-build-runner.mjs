import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outputDirectory = process.argv[2];
const outputPath = outputDirectory ? resolve(outputDirectory) : "";
const outputRelativeToCandidate = outputPath ? relative(process.cwd(), outputPath) : "";
if (!outputDirectory || !isAbsolute(outputDirectory) || outputRelativeToCandidate === "" || (!outputRelativeToCandidate.startsWith(`..${sep}`) && outputRelativeToCandidate !== "..")) {
  throw new Error("A verifier-owned absolute output directory is required");
}
const runnerRoot = dirname(fileURLToPath(import.meta.url));
const toolchainRoot = resolve(runnerRoot, "../toolchain/node_modules");
const { build } = await import(pathToFileURL(join(toolchainRoot, "vite/dist/node/index.js")).href);
const alias = (name, target) => ({ find: name, replacement: join(toolchainRoot, target) });

await build({
  root: process.cwd(),
  configFile: false,
  resolve: {
    alias: [
      alias(/^react$/, "react/index.js"),
      alias(/^react\/jsx-runtime$/, "react/jsx-runtime.js"),
      alias(/^react\/jsx-dev-runtime$/, "react/jsx-dev-runtime.js"),
      alias(/^react-dom$/, "react-dom/index.js"),
      alias(/^react-dom\/client$/, "react-dom/client.js"),
    ],
  },
  build: { outDir: outputPath, emptyOutDir: true },
});
