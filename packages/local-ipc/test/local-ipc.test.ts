import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantId, Principal, ProjectId, RequestId } from "@boxspec/shared/domain";
import type { CoreIpcRequest, CoreUseCases, SafeMcpToolName } from "@boxspec/shared/runtime";
import {
  LocalIpcError,
  assertSafeProfileName,
  createLocalIpcHost,
  createProfileCoreIpcClient,
  loadProfile,
  persistProfile,
  profilePath,
} from "../src/index.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authenticated local IPC", () => {
  it("binds a real named-pipe connection to the server-held MCP principal", async () => {
    const root = await temporaryRoot();
    const invoked: { principal?: Extract<Principal, { kind: "mcp-client" }>; tool?: SafeMcpToolName } = {};
    const mcp: CoreUseCases = {
      async invoke(principal, tool, input) {
        invoked.principal = principal;
        invoked.tool = tool;
        return { ok: true, data: { input } };
      },
    };
    const authorizeSession = vi.fn(async () => undefined);
    const host = createLocalIpcHost({ mcp, authorizeSession, profileRoot: root });
    await host.start();
    try {
      await issue(host, "first");
      const connection = await createProfileCoreIpcClient({ profileName: "first", profileRoot: root });
      try {
        const response = await connection.client.invoke(request("req-1", "boxspec_get_capabilities", {}));
        expect(response.result.ok).toBe(true);
        expect(invoked).toEqual({
          principal: { kind: "mcp-client", principalId: "client-a", grantId: "grant-a" },
          tool: "boxspec_get_capabilities",
        });
        expect(connection.principal).toEqual(invoked.principal);
        expect(authorizeSession).toHaveBeenCalledTimes(1);
      } finally {
        await connection.close();
      }
    } finally {
      await host.close();
    }
  });

  it("classifies a wrong token as PAIRING_REQUIRED without logging it", async () => {
    const root = await temporaryRoot();
    const diagnostics: string[] = [];
    const host = createLocalIpcHost({
      mcp: successfulCore(),
      authorizeSession: async () => undefined,
      profileRoot: root,
      diagnostic: (message, error) => diagnostics.push(`${message}:${error instanceof Error ? error.message : ""}`),
    });
    await host.start();
    try {
      const { profilePath: path, profile } = await issue(host, "wrong-token");
      const wrongToken = randomBytes(32).toString("base64url");
      await writeFile(path, `${JSON.stringify({ ...profile, sessionToken: wrongToken })}\n`, "utf8");
      await expect(createProfileCoreIpcClient({ profileName: "wrong-token", profileRoot: root }))
        .rejects.toMatchObject({ code: "PAIRING_REQUIRED" });
      expect(diagnostics.join("\n")).not.toContain(wrongToken);
      expect(diagnostics.join("\n")).not.toContain(profile.sessionToken);
    } finally {
      await host.close();
    }
  });

  it("rejects expired profiles and expired issuance", async () => {
    const root = await temporaryRoot();
    const now = new Date("2026-09-22T00:00:00.000Z");
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root, clock: () => now });
    await host.start();
    try {
      await expect(host.issuePairingProfile({
        profileName: "expired",
        principalId: "client-a",
        grantId: "grant-a" as GrantId,
        projectId: "project-a" as ProjectId,
        permissions: ["read"],
        expiresAt: "2026-09-21T23:59:59.000Z",
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(host.issuePairingProfile({
        profileName: "too-long",
        principalId: "client-a",
        grantId: "grant-a" as GrantId,
        projectId: "project-a" as ProjectId,
        permissions: ["read"],
        expiresAt: "2026-09-22T00:15:00.001Z",
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const issued = await host.issuePairingProfile({
        profileName: "becomes-expired",
        principalId: "client-a",
        grantId: "grant-a" as GrantId,
        projectId: "project-a" as ProjectId,
        permissions: ["read"],
        expiresAt: "2026-09-22T00:01:00.000Z",
      });
      await expect(loadProfile("becomes-expired", root, new Date("2026-09-22T00:02:00.000Z")))
        .rejects.toMatchObject({ code: "PAIRING_REQUIRED" });
      expect(JSON.parse(await readFile(issued.profilePath, "utf8"))).toMatchObject({ protocolVersion: "1.0.0" });
    } finally {
      await host.close();
    }
  });

  it("rechecks durable authorization on every call and denies a revoked grant", async () => {
    const root = await temporaryRoot();
    let revoked = false;
    const mcp = successfulCore();
    const host = createLocalIpcHost({
      mcp,
      profileRoot: root,
      authorizeSession: async () => { if (revoked) throw new Error("revoked"); },
    });
    await host.start();
    try {
      await issue(host, "revocation");
      const connection = await createProfileCoreIpcClient({ profileName: "revocation", profileRoot: root });
      try {
        expect((await connection.client.invoke(request("before", "boxspec_get_capabilities", {}))).result.ok).toBe(true);
        revoked = true;
        const result = await connection.client.invoke(request("after", "boxspec_get_capabilities", {}));
        expect(result.result).toMatchObject({ ok: false, code: "PROJECT_NOT_GRANTED" });
      } finally {
        await connection.close();
      }
    } finally {
      await host.close();
    }
  });

  it("rejects caller role injection, a desktop channel, and project switching", async () => {
    const root = await temporaryRoot();
    const invoke = vi.fn(successfulCore().invoke);
    const host = createLocalIpcHost({ mcp: { invoke }, authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    try {
      const { profile } = await issue(host, "injection");
      const injected = await rawExchange(profile.pipePath, [
        { type: "authenticate", protocolVersion: "1.0.0", sessionToken: profile.sessionToken },
        { protocolVersion: "1.0.0", channel: "mcp", requestId: "role", tool: "boxspec_get_capabilities", payload: {}, role: "desktop" },
        { protocolVersion: "1.0.0", channel: "desktop", requestId: "desktop", operation: "approveAndApply", payload: {} },
        { protocolVersion: "1.0.0", channel: "mcp", requestId: "project", tool: "boxspec_get_context", payload: { projectId: "other-project" } },
      ], 4);
      expect(injected[1]).toMatchObject({ requestId: "role", result: { ok: false, code: "INVALID_REQUEST" } });
      expect(injected[2]).toMatchObject({ requestId: "desktop", result: { ok: false, code: "INVALID_REQUEST" } });
      expect(injected[3]).toMatchObject({ requestId: "project", result: { ok: false, code: "PROJECT_NOT_GRANTED" } });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });

  it("limits request bytes and propagates cancellation to the app-owned use case", async () => {
    const root = await temporaryRoot();
    let cancelled = false;
    let invocationCount = 0;
    const mcp: CoreUseCases = {
      async invoke(_principal, _tool, _input, signal) {
        invocationCount += 1;
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            cancelled = true;
            resolve({ ok: false, code: "CANCELLED", message: "cancelled", recoverable: true, requestId: "cancel" as RequestId });
          }, { once: true });
        });
      },
    };
    const host = createLocalIpcHost({ mcp, authorizeSession: async () => undefined, profileRoot: root, maxMessageBytes: 1024 });
    await host.start();
    try {
      const { profile } = await issue(host, "limits");
      await expectOversizedFrameDisconnect(profile.pipePath, profile.sessionToken);
      expect(invocationCount).toBe(0);
      const connection = await createProfileCoreIpcClient({ profileName: "limits", profileRoot: root, maxMessageBytes: 1024 });
      try {
        await expect(connection.client.invoke(request("large", "boxspec_get_context", { text: "x".repeat(2_000) })))
          .rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
        const controller = new AbortController();
        const pending = connection.client.invoke(request("cancel", "boxspec_get_capabilities", {}), controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await vi.waitFor(() => expect(cancelled).toBe(true));
      } finally {
        await connection.close();
      }
    } finally {
      await host.close();
    }
  });

  it("supports multiple bridges while keeping the token out of host diagnostics", async () => {
    const root = await temporaryRoot();
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    try {
      const { profile } = await issue(host, "multiple");
      const first = await createProfileCoreIpcClient({ profileName: "multiple", profileRoot: root });
      const second = await createProfileCoreIpcClient({ profileName: "multiple", profileRoot: root });
      try {
        const results = await Promise.all([
          first.client.invoke(request("multi-1", "boxspec_get_capabilities", {})),
          second.client.invoke(request("multi-2", "boxspec_get_capabilities", {})),
        ]);
        expect(results.every((result) => result.result.ok)).toBe(true);
        expect(profile.sessionToken).toHaveLength(43);
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    } finally {
      await host.close();
    }
  });

  it("rotates an existing profile and invalidates its previous token", async () => {
    const root = await temporaryRoot();
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    try {
      const first = await issue(host, "rotation");
      const second = await issue(host, "rotation");
      expect(second.profile.sessionToken).not.toBe(first.profile.sessionToken);
      const rejected = await rawExchange(first.profile.pipePath, [
        { type: "authenticate", protocolVersion: "1.0.0", sessionToken: first.profile.sessionToken },
      ], 1);
      expect(rejected[0]).toMatchObject({ type: "authentication_error", code: "PAIRING_REQUIRED" });
      const connection = await createProfileCoreIpcClient({ profileName: "rotation", profileRoot: root });
      try {
        expect((await connection.client.invoke(request("rotated", "boxspec_get_capabilities", {}))).result.ok).toBe(true);
      } finally {
        await connection.close();
      }
    } finally {
      await host.close();
    }
  });

  it("invalidates active and future connections when the host revokes a grant", async () => {
    const root = await temporaryRoot();
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    try {
      await issue(host, "host-revocation");
      const connection = await createProfileCoreIpcClient({ profileName: "host-revocation", profileRoot: root });
      host.revokeGrant("grant-a" as GrantId);
      await expect(connection.client.invoke(request("revoked", "boxspec_get_capabilities", {})))
        .rejects.toMatchObject({ code: "APP_NOT_RUNNING" });
      await expect(createProfileCoreIpcClient({ profileName: "host-revocation", profileRoot: root }))
        .rejects.toMatchObject({ code: "PAIRING_REQUIRED" });
    } finally {
      await host.close();
    }
  });

  it("classifies an unavailable desktop host as APP_NOT_RUNNING", async () => {
    const root = await temporaryRoot();
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    await issue(host, "app-down");
    await host.close();
    await expect(createProfileCoreIpcClient({ profileName: "app-down", profileRoot: root, connectTimeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "APP_NOT_RUNNING" });
  });

  it.runIf(process.platform === "win32")("persists the profile with a protected current-user Windows DACL", async () => {
    const root = await temporaryRoot();
    const host = createLocalIpcHost({ mcp: successfulCore(), authorizeSession: async () => undefined, profileRoot: root });
    await host.start();
    try {
      const issued = await issue(host, "acl");
      const [{ stdout: sidOutput }, { stdout: sddlOutput }] = await Promise.all([
        execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" }),
        execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "[System.IO.File]::GetAccessControl($env:BOXSPEC_ACL_EVIDENCE_PATH).Sddl"],
          {
            windowsHide: true,
            encoding: "utf8",
            env: { ...process.env, BOXSPEC_ACL_EVIDENCE_PATH: issued.profilePath },
          },
        ),
      ]);
      const currentSid = /"(S-1-[0-9-]+)"/u.exec(sidOutput)?.[1];
      expect(currentSid).toBeTruthy();
      expect(sddlOutput).toContain("D:P");
      expect(sddlOutput).toContain(currentSid);
      expect(sddlOutput).toContain("SY");
      expect(sddlOutput).not.toMatch(/;;;(?:WD|AU|BU)\)/u);
    } finally {
      await host.close();
    }
  });
});

describe("profile paths", () => {
  it.each(["../escape", "..", ".", "C:escape", "\\\\server\\share", "name/child", "name\\child", "CON", "com1.any", "LPT9", "💥"])("rejects unsafe profile %s", (name) => {
    expect(() => assertSafeProfileName(name)).toThrow(LocalIpcError);
  });

  it("keeps a safe profile under the configured root", async () => {
    const root = await temporaryRoot();
    expect(profilePath("client-01", root)).toBe(join(root, "client-01.json"));
  });

  it("rejects a profile root redirected through a link or junction", async () => {
    const root = await temporaryRoot();
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(persistProfile("linked", {
      protocolVersion: "1.0.0",
      pipePath: "\\\\.\\pipe\\boxspec-linked-profile",
      sessionToken: randomBytes(32).toString("base64url"),
      principalId: "client-a",
      grantId: "grant-a" as GrantId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, linkedDirectory)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

function successfulCore(): CoreUseCases {
  return { async invoke() { return { ok: true, data: { connected: true } }; } };
}

async function issue(host: ReturnType<typeof createLocalIpcHost>, profileName: string) {
  return host.issuePairingProfile({
    profileName,
    principalId: "client-a",
    grantId: "grant-a" as GrantId,
    projectId: "project-a" as ProjectId,
    permissions: ["read", "candidate-write", "verify"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function request(requestId: string, tool: SafeMcpToolName, payload: unknown): Extract<CoreIpcRequest, { channel: "mcp" }> {
  return { protocolVersion: "1.0.0", channel: "mcp", requestId: requestId as RequestId, tool, payload };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boxspec-local-ipc-"));
  roots.push(root);
  return root;
}

async function rawExchange(pipePath: string, frames: readonly unknown[], expectedLines: number): Promise<unknown[]> {
  const socket = createConnection(pipePath);
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const lines: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw exchange timed out")); }, 5_000);
    socket.once("connect", () => socket.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        lines.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (lines.length === expectedLines) {
          clearTimeout(timer);
          socket.end();
          resolve(lines);
          return;
        }
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function expectOversizedFrameDisconnect(pipePath: string, sessionToken: string): Promise<void> {
  const socket = createConnection(pipePath);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    let oversizedSent = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("oversized frame was not disconnected")); }, 5_000);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "authenticate", protocolVersion: "1.0.0", sessionToken })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!oversizedSent && buffer.includes("\n")) {
        oversizedSent = true;
        socket.write(`${JSON.stringify({ protocolVersion: "1.0.0", channel: "mcp", requestId: "oversized", tool: "boxspec_get_context", payload: { text: "x".repeat(2_000) } })}\n`);
      }
    });
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.once("error", () => { /* A reset is an acceptable oversized-frame disconnect. */ });
  });
}
