import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChangeManagerError } from "./types.js";
import { compareOrdinal } from "./hash.js";

const execFileAsync = promisify(execFile);

export class GitRepository {
  constructor(
    readonly root: string,
    private readonly binary = "git",
  ) {}

  async text(args: readonly string[], cwd = this.root): Promise<string> {
    try {
      const result = await execFileAsync(this.binary, ["-C", cwd, ...args], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      throw this.asError(error, args);
    }
  }

  async bytes(args: readonly string[], cwd = this.root): Promise<Buffer> {
    try {
      const result = await execFileAsync(this.binary, ["-C", cwd, ...args], {
        encoding: "buffer",
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
      });
      return Buffer.from(result.stdout);
    } catch (error) {
      throw this.asError(error, args);
    }
  }

  async head(): Promise<string> {
    return this.text(["rev-parse", "--verify", "HEAD"]);
  }

  async topLevel(): Promise<string> {
    return this.text(["rev-parse", "--show-toplevel"]);
  }

  async addWorktree(worktreePath: string, commit: string): Promise<void> {
    await this.text(["worktree", "add", "--detach", "--", worktreePath, commit]);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.text(["worktree", "remove", "--force", "--", worktreePath]);
  }

  async changedPaths(worktreePath: string, baseCommit: string): Promise<readonly string[]> {
    const [tracked, untracked] = await Promise.all([
      this.bytes(["diff", "--name-only", "-z", "--no-renames", baseCommit, "--"], worktreePath),
      this.bytes(["ls-files", "-z", "--others", "--exclude-standard"], worktreePath),
    ]);
    return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort(compareOrdinal);
  }

  async snapshotPaths(worktreePath: string): Promise<readonly string[]> {
    return splitNul(await this.bytes(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], worktreePath));
  }

  async readCommittedFile(commit: string, relativePath: string): Promise<Buffer | null> {
    try {
      return await this.bytes(["show", `${commit}:${relativePath}`]);
    } catch (error) {
      if (error instanceof ChangeManagerError && error.details?.["exitCode"] === 128) return null;
      throw error;
    }
  }

  async committedFileExecutable(commit: string, relativePath: string): Promise<boolean | null> {
    const output = await this.bytes(["ls-tree", "-z", commit, "--", relativePath]);
    if (output.byteLength === 0) return null;
    const header = output.toString("utf8").split("\t", 1)[0];
    const mode = header?.split(" ", 1)[0];
    if (mode !== "100644" && mode !== "100755") {
      throw new ChangeManagerError("PROTECTED_PATH", "Committed candidate base contains a non-regular file", false, {
        relativePath,
        mode,
      });
    }
    return mode === "100755";
  }

  private asError(error: unknown, args: readonly string[]): ChangeManagerError {
    const value = error as NodeJS.ErrnoException & { stderr?: string | Buffer; code?: number | string };
    const stderr = Buffer.isBuffer(value.stderr) ? value.stderr.toString("utf8") : String(value.stderr ?? "");
    return new ChangeManagerError("INVALID_REQUEST", "Git operation failed", false, {
      args: [...args],
      exitCode: typeof value.code === "number" ? value.code : -1,
      stderr: stderr.slice(0, 4096),
    });
  }
}

function splitNul(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}
