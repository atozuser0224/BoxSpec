import { open, readFile, rm } from "node:fs/promises";
import { RuntimeError } from "./errors.js";

interface LeaseRecord {
  readonly pid: number;
  readonly startedAt: string;
}

export class RuntimeLease {
  readonly #path: string;
  #released = false;

  private constructor(path: string) {
    this.#path = path;
  }

  static async acquire(path: string): Promise<RuntimeLease> {
    const lease = new RuntimeLease(path);
    try {
      await lease.#create();
      return lease;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    const existing = await readLease(path);
    if (existing === null) {
      throw new RuntimeError("APP_NOT_RUNNING", "Runtime lock exists but its owner cannot be verified", {
        recoverable: true,
      });
    }
    if (existing !== null && processIsAlive(existing.pid)) {
      throw new RuntimeError("APP_NOT_RUNNING", "Another BoxSpec runtime already owns this data directory", {
        recoverable: true,
        details: { ownerPid: existing.pid },
      });
    }

    // The exact lease file is stale. Removal is bounded to this data directory's
    // known lock path; a racing process must still win an exclusive `wx` create.
    await rm(path, { force: true });
    try {
      await lease.#create();
      return lease;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new RuntimeError("APP_NOT_RUNNING", "Another BoxSpec runtime acquired this data directory", {
          recoverable: true,
        });
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readLease(this.#path);
    if (current?.pid === process.pid) await rm(this.#path, { force: true });
  }

  async #create(): Promise<void> {
    const handle = await open(this.#path, "wx", 0o600);
    try {
      const record: LeaseRecord = { pid: process.pid, startedAt: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function readLease(path: string): Promise<LeaseRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && "pid" in value && Number.isSafeInteger(value.pid)) {
      return value as LeaseRecord;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
