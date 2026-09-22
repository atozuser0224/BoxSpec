#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { doctorExitCode, formatDoctorReport, runDoctor } from "./doctor.js";
import type { BridgeCommand } from "./types.js";

interface ParsedArguments {
  readonly json: boolean;
  readonly output?: string;
  readonly timeoutMs: number;
  readonly bridge?: BridgeCommand;
  readonly statePath?: string;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv[0] !== "doctor") throw new UsageError("Expected the 'doctor' command.");
  const options = parseArguments(argv.slice(1));
  const report = await runDoctor({
    timeoutMs: options.timeoutMs,
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
    ...(options.statePath === undefined ? {} : { statePath: options.statePath }),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output !== undefined) {
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, json, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(options.json ? json : `${formatDoctorReport(report)}\n`);
  return doctorExitCode(report);
}

function parseArguments(args: readonly string[]): ParsedArguments {
  let json = false;
  let output: string | undefined;
  let timeoutMs = 8_000;
  let bridgeCommand: string | undefined;
  const bridgeArgs: string[] = [];
  let statePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--json": json = true; break;
      case "--output": output = requiredValue(args, ++index, argument); break;
      case "--timeout-ms": {
        const raw = requiredValue(args, ++index, argument);
        timeoutMs = Number(raw);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new UsageError("--timeout-ms must be an integer from 500 to 60000.");
        break;
      }
      case "--bridge-command": bridgeCommand = requiredValue(args, ++index, argument); break;
      case "--bridge-arg": bridgeArgs.push(requiredValue(args, ++index, argument)); break;
      case "--state": statePath = requiredValue(args, ++index, argument); break;
      default: throw new UsageError(`Unknown option: ${argument ?? ""}`);
    }
  }
  return {
    json,
    timeoutMs,
    ...(output === undefined ? {} : { output }),
    ...(statePath === undefined ? {} : { statePath }),
    ...(bridgeCommand === undefined ? {} : { bridge: { command: bridgeCommand, args: bridgeArgs, cwd: process.cwd() } }),
  };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${option} requires a value.`);
  return value;
}

function helpText(): string {
  return `Usage: boxspec doctor [options]\n\nOptions:\n  --json                    Print redacted JSON\n  --output <path>           Save the same redacted JSON report\n  --timeout-ms <500-60000>  Per-probe timeout (default: 8000)\n  --bridge-command <path>   BoxSpec MCP launcher to probe\n  --bridge-arg <value>      Launcher argument; repeat as needed\n  --state <path>            BoxSpec-owned diagnostic state JSON\n  -h, --help                Show this help\n\nExit codes:\n  0  Every required probe passed\n  1  At least one probe failed\n  2  No failure, but evidence is unavailable, unknown, or not run\n  64 Invalid command-line usage\n`;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\nRun 'boxspec --help' for usage.\n`);
      process.exitCode = 64;
      return;
    }
    process.stderr.write(`BoxSpec doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
