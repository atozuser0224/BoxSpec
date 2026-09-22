import { canonicalJson, sha256, type JsonValue } from "./canonical.js";
import { UpdaterError } from "./errors.js";
import type { ActiveSelection, UpdateJournal, UpdateJournalData, UpdatePhase } from "./types.js";

const phases = new Set<UpdatePhase>(["PREPARING", "STAGING", "STAGED_VERIFIED", "ACTIVATING", "HEALTH_PENDING", "ROLLBACK_REQUIRED", "COMMITTED", "ROLLED_BACK"]);
const hash = /^[0-9a-f]{64}$/u;
const token = /^[A-Za-z0-9._-]{1,128}$/u;

export function sealJournal(data: UpdateJournalData): UpdateJournal {
  return Object.freeze({ ...data, checksum: sha256(canonicalJson(asJson(data))) });
}

export function updateJournal(journal: UpdateJournal, patch: Partial<UpdateJournalData>): UpdateJournal {
  const { checksum: _checksum, ...data } = journal;
  return sealJournal({ ...data, ...patch });
}

export function parseJournal(value: unknown): UpdateJournal {
  if (!isRecord(value)) bad();
  const names = ["schemaVersion","transactionId","phase","manifestDigest","releaseId","channel","sequence","version","previousSelection","nextSelection","previousDataSchema","targetDataSchema","backupRef","checksum"];
  if (!sameKeys(value, names) || value.schemaVersion !== 1 || typeof value.phase !== "string" || !phases.has(value.phase as UpdatePhase) || typeof value.checksum !== "string" || !hash.test(value.checksum)) bad();
  const data: UpdateJournalData = {
    schemaVersion: 1,
    transactionId: bounded(value.transactionId, token), phase: value.phase as UpdatePhase,
    manifestDigest: bounded(value.manifestDigest, hash), releaseId: bounded(value.releaseId, token),
    channel: value.channel === "stable" || value.channel === "beta" ? value.channel : bad(),
    sequence: integer(value.sequence), version: bounded(value.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u),
    previousSelection: selection(value.previousSelection), nextSelection: value.nextSelection === null ? null : selection(value.nextSelection),
    previousDataSchema: integer(value.previousDataSchema, true), targetDataSchema: integer(value.targetDataSchema, true),
    backupRef: value.backupRef === null ? null : bounded(value.backupRef),
  };
  const expected = sealJournal(data);
  if (expected.checksum !== value.checksum) throw new UpdaterError("JOURNAL_INVALID", "update journal checksum mismatch");
  return expected;
}

function asJson(d: UpdateJournalData): JsonValue { return { schemaVersion:d.schemaVersion,transactionId:d.transactionId,phase:d.phase,manifestDigest:d.manifestDigest,releaseId:d.releaseId,channel:d.channel,sequence:d.sequence,version:d.version,previousSelection:{selectionRef:d.previousSelection.selectionRef,version:d.previousSelection.version},nextSelection:d.nextSelection===null?null:{selectionRef:d.nextSelection.selectionRef,version:d.nextSelection.version},previousDataSchema:d.previousDataSchema,targetDataSchema:d.targetDataSchema,backupRef:d.backupRef }; }
function selection(v: unknown): ActiveSelection { if (!isRecord(v) || !sameKeys(v,["selectionRef","version"])) bad(); return { selectionRef:bounded(v.selectionRef),version:bounded(v.version,/^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u) }; }
function bounded(v: unknown, p?: RegExp): string { if (typeof v!=="string" || v.length<1 || v.length>1024 || /[\u0000-\u001f]/u.test(v) || (p && !p.test(v))) bad(); return v; }
function integer(v: unknown, zero=false): number { if (!Number.isSafeInteger(v) || (v as number)<(zero?0:1)) bad(); return v as number; }
function sameKeys(v: Record<string,unknown>, names:string[]):boolean { const a=Object.keys(v).sort(), b=[...names].sort(); return a.length===b.length && a.every((x,i)=>x===b[i]); }
function isRecord(v: unknown): v is Record<string,unknown> { return v!==null && typeof v==="object" && !Array.isArray(v); }
function bad(): never { throw new UpdaterError("JOURNAL_INVALID", "invalid update journal"); }
