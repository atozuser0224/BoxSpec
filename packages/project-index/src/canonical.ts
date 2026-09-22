import { createHash } from "node:crypto";
import type { JsonValue } from "@boxspec/shared/domain";
import { canonicalJson } from "@boxspec/shared/hashing";

export function hashProjectIndexProjection(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
