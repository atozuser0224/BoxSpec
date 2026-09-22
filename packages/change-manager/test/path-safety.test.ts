import { describe, expect, it } from "vitest";
import { normalizeRelativePath, windowsCollisionKey } from "../src/index.js";

describe("Windows path policy", () => {
  it.each([
    "../escape.ts",
    "C:drive-relative.ts",
    "C:/absolute.ts",
    "\\\\server\\share\\file.ts",
    "\\\\?\\C:\\device.ts",
    "\\\\.\\pipe\\name",
    "folder/file.ts:stream",
    "folder/trailing. ",
    "CON.txt",
    "com¹.log",
    "folder/*.ts",
  ])("rejects alias, device, traversal, ADS, or wildcard path %s", (candidate) => {
    expect(() => normalizeRelativePath(candidate)).toThrow();
  });

  it("uses stable NFC plus Windows-style case folding for collision detection", () => {
    expect(windowsCollisionKey("UI/Café.tsx")).toBe(windowsCollisionKey("ui/Cafe\u0301.tsx"));
  });
});
