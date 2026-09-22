import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { canonicalJson, hashContract } from "./canonical.js";
import { parseCoreCommand } from "./commands.js";
import { CoreError } from "./errors.js";
import { atomicExportContract, contractExportPath, readContractFile } from "./io.js";
import { readVersionedContractFile } from "./migration.js";
import type { Actor, CoreCommand, LayoutContract, StoredCommand } from "./model.js";
import { CoreRepository, type CommandResult, type UndoInput } from "./repository.js";

export interface BoxSpecCoreOptions { databasePath: string; exportRoot?: string }
export type Reconciliation =
  | { status: "current"; databaseHash: string; exportHash: string; path: string }
  | { status: "missing"; databaseHash: string; path: string }
  | { status: "drift" | "invalid"; databaseHash: string; exportHash?: string; path: string; reason?: string };

export class BoxSpecCore {
  readonly #repository: CoreRepository;
  private constructor(readonly options: BoxSpecCoreOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.#repository = new CoreRepository(options.databasePath);
  }
  static open(options: BoxSpecCoreOptions): BoxSpecCore { return new BoxSpecCore(options); }
  close(): void { this.#repository.close(); }
  createProject(input: { projectId: string; name: string; createdAt: string }): void { this.#repository.createProject(input); }
  createScreen(input: { contract: LayoutContract; commandId: string; actor: Actor; timestamp: string }): CommandResult {
    const result = this.#repository.createScreen(input); this.#exportIfConfigured(result.contract); return result;
  }
  getScreen(projectId: string, screenId: string): LayoutContract { return this.#repository.getScreen(projectId, screenId); }
  listScreens(projectId: string): Array<{ screenId: string; name: string; revision: number; contractHash: string }> { return this.#repository.listScreens(projectId); }
  execute(command: CoreCommand | unknown): CommandResult { const parsed = parseCoreCommand(command); const result = this.#repository.execute(parsed); this.#exportIfConfigured(result.contract); return result; }
  undo(input: UndoInput): CommandResult { const result = this.#repository.undo(input); this.#exportIfConfigured(result.contract); return result; }
  redo(input: UndoInput): CommandResult { const result = this.#repository.redo(input); this.#exportIfConfigured(result.contract); return result; }
  history(projectId: string, screenId: string): StoredCommand[] { return this.#repository.history(projectId, screenId); }
  exportScreen(projectId: string, screenId: string, path?: string): { path: string; hash: string } {
    const contract = this.getScreen(projectId, screenId);
    const target = path ?? this.#configuredPath(projectId, screenId);
    return atomicExportContract(target, contract);
  }
  importScreenDraft(input: { path: string; draftId: string; importedAt: string }): { draftId: string; contract: LayoutContract; sourceHash: string } {
    const read = readContractFile(input.path);
    const contract = this.#repository.saveImportDraft({ draftId: input.draftId, contract: read.contract, importedAt: input.importedAt, sourceHash: read.sourceHash });
    return { draftId: input.draftId, contract, sourceHash: read.sourceHash };
  }
  openExternalContract(path: string): ReturnType<typeof readVersionedContractFile> { return readVersionedContractFile(path); }
  reconcileScreen(projectId: string, screenId: string): Reconciliation {
    const contract = this.getScreen(projectId, screenId), databaseHash = hashContract(contract), path = this.#configuredPath(projectId, screenId);
    if (!existsSync(path)) return { status: "missing", databaseHash, path };
    try {
      const exported = readContractFile(path), exportHash = hashContract(exported.contract);
      return exportHash === databaseHash && canonicalJson(exported.contract) === canonicalJson(contract)
        ? { status: "current", databaseHash, exportHash, path }
        : { status: "drift", databaseHash, exportHash, path };
    } catch (error) {
      return { status: "invalid", databaseHash, path, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  repairExport(projectId: string, screenId: string): { path: string; hash: string } { return this.exportScreen(projectId, screenId); }
  #configuredPath(projectId: string, screenId: string): string {
    if (!this.options.exportRoot) throw new CoreError("PERSISTENCE_ERROR", "No exportRoot was configured", { projectId, screenId });
    return contractExportPath(this.options.exportRoot, projectId, screenId);
  }
  #exportIfConfigured(contract: LayoutContract): void { if (this.options.exportRoot) this.exportScreen(contract.projectId, contract.screenId); }
}
