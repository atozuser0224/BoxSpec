import Database from "better-sqlite3";
import { CoreError } from "./errors.js";
import { canonicalJson, cloneContract, hashContract, sha256 } from "./canonical.js";
import type { Actor, CoreCommand, LayoutContract, StoredCommand } from "./model.js";
import { applyLayoutOverrides, assertAgentContractChangeAllowed } from "./policy.js";
import { parseLayoutContract } from "./validation.js";

interface ScreenRow { contract_json: string; contract_hash: string; revision: number; undo_json?: string; redo_json?: string }
interface CommandRow { request_hash: string; result_json: string }
export interface CommandResult { commandId: string; projectId: string; screenId: string; revision: number; contractHash: string; contract: LayoutContract; replayed: boolean }
export interface UndoInput { projectId: string; screenId: string; commandId: string; expectedRevision: number; actor: Actor; timestamp: string }

function asContractWithRevision(contract: LayoutContract, revision: number): LayoutContract { return { ...cloneContract(contract), revision }; }
function checkTimestamp(timestamp: string): void {
  if (!Number.isFinite(Date.parse(timestamp))) throw new CoreError("SCHEMA_INVALID", "Command timestamp must be an ISO-compatible timestamp", { timestamp });
}
export class CoreRepository {
  readonly #db: Database.Database;
  #closed = false;
  constructor(readonly databasePath: string) {
    this.#db = new Database(databasePath);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS screens (
        project_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        undo_json TEXT NOT NULL DEFAULT '[]',
        redo_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(project_id, screen_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        resulting_revision INTEGER NOT NULL,
        actor_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        command_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        FOREIGN KEY(project_id, screen_id) REFERENCES screens(project_id, screen_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS commands_screen_sequence ON commands(project_id, screen_id, sequence);
      CREATE TABLE IF NOT EXISTS import_drafts (
        draft_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        screen_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        contract_json TEXT NOT NULL
      ) STRICT;
    `);
    const screenColumns = new Set((this.#db.prepare("PRAGMA table_info(screens)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!screenColumns.has("undo_json")) this.#db.exec("ALTER TABLE screens ADD COLUMN undo_json TEXT NOT NULL DEFAULT '[]'");
    if (!screenColumns.has("redo_json")) this.#db.exec("ALTER TABLE screens ADD COLUMN redo_json TEXT NOT NULL DEFAULT '[]'");
  }
  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
  createProject(input: { projectId: string; name: string; createdAt: string }): void {
    checkTimestamp(input.createdAt);
    try { this.#db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)").run(input.projectId, input.name, input.createdAt); }
    catch (error) { throw new CoreError("PERSISTENCE_ERROR", "Could not create project", { cause: String(error), projectId: input.projectId }); }
  }
  createScreen(input: { contract: LayoutContract; commandId: string; actor: Actor; timestamp: string }): CommandResult {
    checkTimestamp(input.timestamp);
    if (input.actor.kind === "agent") throw new CoreError("POLICY_VIOLATION", "Agents cannot publish a new approved screen contract", {});
    const contract = parseLayoutContract(input.contract);
    if (contract.revision !== 1) throw new CoreError("REVISION_CONFLICT", "A new screen must begin at revision 1", { revision: contract.revision });
    const command: CoreCommand = { type: "replace-contract", commandId: input.commandId, expectedRevision: 0, actor: input.actor, timestamp: input.timestamp, projectId: contract.projectId, screenId: contract.screenId, contract };
    const requestHash = sha256(canonicalJson(command));
    const replay = this.#readReplay(input.commandId, requestHash);
    if (replay) return replay;
    const contractJson = canonicalJson(contract);
    const contractHash = hashContract(contract);
    this.#transaction(() => {
      const existing = this.#db.prepare("SELECT revision FROM screens WHERE project_id=? AND screen_id=?").get(contract.projectId, contract.screenId);
      if (existing) throw new CoreError("REVISION_CONFLICT", "Screen already exists", { projectId: contract.projectId, screenId: contract.screenId });
      this.#db.prepare("INSERT INTO screens(project_id,screen_id,revision,contract_json,contract_hash,updated_at,undo_json,redo_json) VALUES(?,?,?,?,?,?,?,?)").run(contract.projectId, contract.screenId, 1, contractJson, contractHash, input.timestamp, "[]", "[]");
      const result: CommandResult = { commandId: input.commandId, projectId: contract.projectId, screenId: contract.screenId, revision: 1, contractHash, contract, replayed: false };
      this.#insertCommand(command, requestHash, "", contractHash, "", contractJson, result);
    });
    return { commandId: input.commandId, projectId: contract.projectId, screenId: contract.screenId, revision: 1, contractHash, contract, replayed: false };
  }
  getScreen(projectId: string, screenId: string): LayoutContract {
    const row = this.#db.prepare("SELECT contract_json,contract_hash,revision FROM screens WHERE project_id=? AND screen_id=?").get(projectId, screenId) as unknown as ScreenRow | undefined;
    if (!row) throw new CoreError("NOT_FOUND", "Screen does not exist", { projectId, screenId });
    const contract = parseLayoutContract(JSON.parse(row.contract_json) as unknown);
    if (hashContract(contract) !== row.contract_hash || contract.revision !== row.revision) throw new CoreError("PERSISTENCE_ERROR", "Stored contract integrity check failed", { projectId, screenId });
    return contract;
  }
  listScreens(projectId: string): Array<{ screenId: string; name: string; revision: number; contractHash: string }> {
    const rows = this.#db.prepare("SELECT screen_id,revision,contract_hash,contract_json FROM screens WHERE project_id=? ORDER BY screen_id").all(projectId) as unknown as Array<{ screen_id: string; revision: number; contract_hash: string; contract_json: string }>;
    return rows.map((row) => ({ screenId: row.screen_id, name: (JSON.parse(row.contract_json) as { name: string }).name, revision: row.revision, contractHash: row.contract_hash }));
  }
  execute(command: CoreCommand): CommandResult {
    checkTimestamp(command.timestamp);
    const requestHash = sha256(canonicalJson(command));
    const replay = this.#readReplay(command.commandId, requestHash);
    if (replay) return replay;
    return this.#transaction(() => {
      const before = this.getScreen(command.projectId, command.screenId);
      if (before.revision !== command.expectedRevision) throw new CoreError("REVISION_CONFLICT", "Command expected a different screen revision", { expectedRevision: command.expectedRevision, actualRevision: before.revision });
      let next: LayoutContract;
      if (command.type === "replace-contract") {
        if (command.contract.projectId !== command.projectId || command.contract.screenId !== command.screenId) throw new CoreError("SCHEMA_INVALID", "Command identity does not match replacement contract", {});
        next = parseLayoutContract(command.contract);
        if (next.revision !== before.revision + 1) throw new CoreError("REVISION_CONFLICT", "Replacement contract must increment revision exactly once", { expectedRevision: before.revision + 1, revision: next.revision });
        assertAgentContractChangeAllowed(before, next, command.actor);
      } else if (command.type === "apply-layout-overrides") {
        next = asContractWithRevision(applyLayoutOverrides(before, command.overrides, command.actor).contract, before.revision + 1);
        next = parseLayoutContract(next);
      } else {
        if (command.actor.kind === "agent" && before.defaultPolicy.presentation === "hard") throw new CoreError("POLICY_VIOLATION", "Screen name is presentation-hard for agents", {});
        next = parseLayoutContract({ ...cloneContract(before), name: command.name, revision: before.revision + 1 });
      }
      const beforeJson = canonicalJson(before);
      const afterJson = canonicalJson(next);
      const beforeHash = hashContract(before);
      const afterHash = hashContract(next);
      const result: CommandResult = { commandId: command.commandId, projectId: command.projectId, screenId: command.screenId, revision: next.revision, contractHash: afterHash, contract: next, replayed: false };
      const stacks = this.#readStacks(command.projectId, command.screenId);
      stacks.undo.push(beforeJson); if (stacks.undo.length > 100) stacks.undo.shift(); stacks.redo = [];
      this.#db.prepare("UPDATE screens SET revision=?,contract_json=?,contract_hash=?,updated_at=?,undo_json=?,redo_json=? WHERE project_id=? AND screen_id=?").run(next.revision, afterJson, afterHash, command.timestamp, canonicalJson(stacks.undo), canonicalJson(stacks.redo), command.projectId, command.screenId);
      this.#insertCommand(command, requestHash, beforeHash, afterHash, beforeJson, afterJson, result);
      return result;
    });
  }
  undo(input: UndoInput): CommandResult {
    checkTimestamp(input.timestamp);
    if (input.actor.kind === "agent") throw new CoreError("POLICY_VIOLATION", "Agents cannot invoke trusted undo", {});
    const requestHash = sha256(canonicalJson({ type: "undo", ...input }));
    const replay = this.#readReplay(input.commandId, requestHash);
    if (replay) return replay;
    return this.#transaction(() => {
      const before = this.getScreen(input.projectId, input.screenId);
      if (before.revision !== input.expectedRevision) throw new CoreError("REVISION_CONFLICT", "Undo expected a different screen revision", { expectedRevision: input.expectedRevision, actualRevision: before.revision });
      const stacks = this.#readStacks(input.projectId, input.screenId);
      const previous = stacks.undo.pop();
      if (!previous) throw new CoreError("NOT_FOUND", "No command is available to undo", { projectId: input.projectId, screenId: input.screenId });
      stacks.redo.push(canonicalJson(before)); if (stacks.redo.length > 100) stacks.redo.shift();
      const restored = parseLayoutContract({ ...(JSON.parse(previous) as LayoutContract), revision: before.revision + 1 });
      const command: CoreCommand = { type: "replace-contract", projectId: input.projectId, screenId: input.screenId, contract: restored, commandId: input.commandId, expectedRevision: input.expectedRevision, actor: input.actor, timestamp: input.timestamp };
      const beforeJson = canonicalJson(before), afterJson = canonicalJson(restored), beforeHash = hashContract(before), afterHash = hashContract(restored);
      const result: CommandResult = { commandId: input.commandId, projectId: input.projectId, screenId: input.screenId, revision: restored.revision, contractHash: afterHash, contract: restored, replayed: false };
      this.#db.prepare("UPDATE screens SET revision=?,contract_json=?,contract_hash=?,updated_at=?,undo_json=?,redo_json=? WHERE project_id=? AND screen_id=?").run(restored.revision, afterJson, afterHash, input.timestamp, canonicalJson(stacks.undo), canonicalJson(stacks.redo), input.projectId, input.screenId);
      this.#insertCommand(command, requestHash, beforeHash, afterHash, beforeJson, afterJson, result, "undo");
      return result;
    });
  }
  redo(input: UndoInput): CommandResult {
    checkTimestamp(input.timestamp);
    if (input.actor.kind === "agent") throw new CoreError("POLICY_VIOLATION", "Agents cannot invoke trusted redo", {});
    const requestHash = sha256(canonicalJson({ type: "redo", ...input }));
    const replay = this.#readReplay(input.commandId, requestHash);
    if (replay) return replay;
    return this.#transaction(() => {
      const before = this.getScreen(input.projectId, input.screenId);
      if (before.revision !== input.expectedRevision) throw new CoreError("REVISION_CONFLICT", "Redo expected a different screen revision", { expectedRevision: input.expectedRevision, actualRevision: before.revision });
      const stacks = this.#readStacks(input.projectId, input.screenId);
      const following = stacks.redo.pop();
      if (!following) throw new CoreError("NOT_FOUND", "No command is available to redo", { projectId: input.projectId, screenId: input.screenId });
      stacks.undo.push(canonicalJson(before)); if (stacks.undo.length > 100) stacks.undo.shift();
      const restored = parseLayoutContract({ ...(JSON.parse(following) as LayoutContract), revision: before.revision + 1 });
      const command: CoreCommand = { type: "replace-contract", projectId: input.projectId, screenId: input.screenId, contract: restored, commandId: input.commandId, expectedRevision: input.expectedRevision, actor: input.actor, timestamp: input.timestamp };
      const beforeJson = canonicalJson(before), afterJson = canonicalJson(restored), beforeHash = hashContract(before), afterHash = hashContract(restored);
      const result: CommandResult = { commandId: input.commandId, projectId: input.projectId, screenId: input.screenId, revision: restored.revision, contractHash: afterHash, contract: restored, replayed: false };
      this.#db.prepare("UPDATE screens SET revision=?,contract_json=?,contract_hash=?,updated_at=?,undo_json=?,redo_json=? WHERE project_id=? AND screen_id=?").run(restored.revision, afterJson, afterHash, input.timestamp, canonicalJson(stacks.undo), canonicalJson(stacks.redo), input.projectId, input.screenId);
      this.#insertCommand(command, requestHash, beforeHash, afterHash, beforeJson, afterJson, result, "redo");
      return result;
    });
  }
  history(projectId: string, screenId: string): StoredCommand[] {
    const rows = this.#db.prepare("SELECT command_id,project_id,screen_id,expected_revision,resulting_revision,actor_json,timestamp,command_type,before_hash,after_hash,payload_json FROM commands WHERE project_id=? AND screen_id=? ORDER BY sequence").all(projectId, screenId) as unknown as Array<Record<string, string | number>>;
    return rows.map((row) => ({ commandId: String(row.command_id), projectId: String(row.project_id), screenId: String(row.screen_id), expectedRevision: Number(row.expected_revision), resultingRevision: Number(row.resulting_revision), actor: JSON.parse(String(row.actor_json)) as Actor, timestamp: String(row.timestamp), type: String(row.command_type) as StoredCommand["type"], beforeHash: String(row.before_hash), afterHash: String(row.after_hash), payloadJson: String(row.payload_json) }));
  }
  saveImportDraft(input: { draftId: string; contract: unknown; importedAt: string; sourceHash?: string }): LayoutContract {
    checkTimestamp(input.importedAt);
    const contract = parseLayoutContract(input.contract);
    const json = canonicalJson(contract);
    const sourceHash = input.sourceHash ?? sha256(json);
    this.#db.prepare("INSERT INTO import_drafts(draft_id,project_id,screen_id,imported_at,source_hash,contract_json) VALUES(?,?,?,?,?,?)").run(input.draftId, contract.projectId, contract.screenId, input.importedAt, sourceHash, json);
    return contract;
  }
  #readReplay(commandId: string, requestHash: string): CommandResult | undefined {
    const row = this.#db.prepare("SELECT request_hash,result_json FROM commands WHERE command_id=?").get(commandId) as unknown as CommandRow | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new CoreError("COMMAND_ID_CONFLICT", "Command id was already used with a different payload", { commandId });
    return { ...(JSON.parse(row.result_json) as CommandResult), replayed: true };
  }
  #readStacks(projectId: string, screenId: string): { undo: string[]; redo: string[] } {
    const row = this.#db.prepare("SELECT undo_json,redo_json FROM screens WHERE project_id=? AND screen_id=?").get(projectId, screenId) as unknown as { undo_json: string; redo_json: string } | undefined;
    if (!row) throw new CoreError("NOT_FOUND", "Screen does not exist", { projectId, screenId });
    return { undo: JSON.parse(row.undo_json) as string[], redo: JSON.parse(row.redo_json) as string[] };
  }
  #insertCommand(command: CoreCommand, requestHash: string, beforeHash: string, afterHash: string, beforeJson: string, afterJson: string, result: CommandResult, type: StoredCommand["type"] = command.type): void {
    this.#db.prepare("INSERT INTO commands(command_id,project_id,screen_id,expected_revision,resulting_revision,actor_json,timestamp,command_type,request_hash,before_hash,after_hash,before_json,after_json,payload_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(command.commandId, command.projectId, command.screenId, command.expectedRevision, result.revision, canonicalJson(command.actor), command.timestamp, type, requestHash, beforeHash, afterHash, beforeJson, afterJson, canonicalJson(command), canonicalJson(result));
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}
