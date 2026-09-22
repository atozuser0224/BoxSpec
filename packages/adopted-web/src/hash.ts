import { createHash } from "node:crypto";

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").toUpperCase();
}

export function stableId(prefix: string, input: string, length = 20): string {
  return prefix + createHash("sha256").update(input, "utf8").digest("hex").slice(0, length);
}
