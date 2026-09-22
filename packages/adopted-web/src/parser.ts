import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import type { SourceFile } from "typescript/unstable/ast";
import type { AdoptedWebLanguage } from "./types.js";

export interface ParseDiagnostic {
  readonly pos: number;
  readonly end: number;
  readonly text: string;
}

/** Parses only caller-supplied text inside an in-memory TypeScript 7 virtual filesystem. */
export function withParsedSource<T>(language: AdoptedWebLanguage, content: string, use: (source: SourceFile, diagnostics: readonly ParseDiagnostic[]) => T): T {
  const extension = language === "tsx" ? ".tsx" : ".jsx";
  const root = "/boxspec-adopted-input";
  const fileName = root + "/source" + extension;
  const configName = root + "/tsconfig.json";
  const files = {
    [configName]: JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, jsx: "preserve", noLib: true }, files: ["source" + extension] }),
    [fileName]: content,
  };
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openProjects: [configName] });
    const project = snapshot.getProjects()[0];
    const source = project?.program.getSourceFile(fileName);
    if (!project || !source) throw new Error("TypeScript virtual parser did not return the supplied source");
    const diagnostics = project.program.getSyntacticDiagnostics(fileName).map((item) => ({ pos: item.pos, end: item.end, text: item.text }));
    return use(source, diagnostics);
  } finally {
    snapshot?.dispose();
    api.close();
  }
}
