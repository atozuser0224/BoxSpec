import { homedir, tmpdir } from "node:os";
import path from "node:path";

const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|session|token|api[-_]?key|private[-_]?key)/i;
const ASSIGNMENT_SECRET = /\b(authorization|cookie|password|secret|token|api[-_]?key)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

export function redactString(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = value;
  const roots = [env.USERPROFILE, env.HOME, homedir()].filter(isNonEmpty).sort((a, b) => b.length - a.length);
  for (const root of roots) output = replacePath(output, root, "<home>");
  output = replacePath(output, tmpdir(), "<temp>");
  output = output.replace(URL_CREDENTIALS, "$1[REDACTED]@");
  output = output.replace(BEARER, "$1 [REDACTED]");
  output = output.replace(TOKEN_SHAPES, REDACTED);
  output = output.replace(ASSIGNMENT_SECRET, (_match, key: string) => `${key}=${REDACTED}`);
  return output;
}

export function redactValue(value: unknown, env: NodeJS.ProcessEnv = process.env, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value, env);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, env, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, env, seen);
  }
  return output;
}

function replacePath(input: string, target: string, replacement: string): string {
  if (target.length < 3) return input;
  const normalizedTarget = path.normalize(target).replace(/[\\/]+$/, "");
  const variants = new Set([target, normalizedTarget, normalizedTarget.replaceAll("\\", "/")]);
  let output = input;
  for (const variant of variants) {
    if (variant.length < 3) continue;
    output = output.replace(new RegExp(escapeRegExp(variant), process.platform === "win32" ? "gi" : "g"), replacement);
  }
  return output;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 3;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
