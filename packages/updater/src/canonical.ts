import { createHash } from "node:crypto";
import { UpdaterError } from "./errors.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 24;

/** Parses strict JSON while rejecting duplicate keys, unsafe numbers, and excessive depth. */
export function parseStrictJson(text: string): JsonValue {
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) fail("JSON exceeds 1 MiB");
  let offset = 0;
  const whitespace = () => { while (" \t\r\n".includes(text[offset] ?? "\u0000")) offset++; };

  const string = (): string => {
    if (text[offset] !== '"') fail("expected string");
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (!escaped && char === '"') {
        try { return JSON.parse(text.slice(start, offset)) as string; }
        catch { fail("invalid string escape"); }
      }
      if (!escaped && char < " ") fail("control character in string");
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    return fail("unterminated string");
  };

  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail("JSON nesting is too deep");
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      const names = new Set<string>();
      whitespace();
      if (text[offset] === "}") { offset++; return output; }
      for (;;) {
        whitespace();
        const key = string();
        if (names.has(key)) fail(`duplicate object key: ${key}`);
        names.add(key);
        whitespace();
        if (text[offset++] !== ":") fail("expected colon");
        output[key] = value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === "}") return output;
        if (separator !== ",") fail("expected comma or object end");
      }
    }
    if (char === "[") {
      offset++;
      const output: JsonValue[] = [];
      whitespace();
      if (text[offset] === "]") { offset++; return output; }
      for (;;) {
        output.push(value(depth + 1));
        whitespace();
        const separator = text[offset++];
        if (separator === "]") return output;
        if (separator !== ",") fail("expected comma or array end");
      }
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, offset)) { offset += token.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/u.exec(text.slice(offset));
    if (!match) return fail("invalid JSON value");
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) fail("numbers must be safe integers");
    return number;
  };

  const output = value(0);
  whitespace();
  if (offset !== text.length) fail("trailing JSON input");
  return output;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical JSON requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new UpdaterError("INVALID_MANIFEST", message);
}
