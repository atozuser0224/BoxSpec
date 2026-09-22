import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { TrustedUpdater, UpdaterError } from "../dist/index.js";

const canonical=(v)=>v===null||typeof v==="boolean"||typeof v==="string"?JSON.stringify(v):typeof v==="number"?String(v):Array.isArray(v)?`[${v.map(canonical).join(",")}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const digest=(v)=>createHash("sha256").update(typeof v==="string"?v:canonical(v)).digest("hex");
const {publicKey,privateKey}=generateKeyPairSync("ed25519");
const publisher={publisherId:"boxspec-production",subject:"CN=BoxSpec Production",certificateSha256:"a".repeat(64),allowedRoles:["application-executable","native-safe-fs","browser-executable","installer"]};
const trust={keys:[{keyId:"release-2026",publicKey}],publishers:[publisher]};

function artifacts(){
  const rows=[
    ["BoxSpec.exe","application-executable","installation","boxspec-production"],
    ["resources/app.asar","application-archive","installation",null],
    ["resources/native/boxspec-safe-fs.exe","native-safe-fs","installation","boxspec-production"],
    ["resources/verification-tools.json","verification-manifest","installation",null],
    ["resources/verification/chromium/chrome.exe","browser-executable","installation","boxspec-production"],
    ["resources/verification/chromium/icudtl.dat","verification-asset","installation",null],
    ["BoxSpec-1.1.0-win-x64.zip","portable-archive","package",null],
    ["BoxSpec-Setup-1.1.0.exe","installer","package","boxspec-production"],
  ];
  return rows.map(([relativePath,role,scope,publisherId],i)=>({relativePath,role,scope,sha256:String(i+1).repeat(64),sizeBytes:100+i,publisherId}));
}
function manifest(overrides={}){ const list=overrides.artifacts??artifacts(); return {schemaVersion:1,product:"BoxSpec",releaseId:"release-1.1.0",version:"1.1.0",channel:"stable",sequence:11,publishedAt:"2026-09-22T00:00:00.000Z",expiresAt:"2026-10-22T00:00:00.000Z",artifactSetSha256:digest([...list].sort((a,b)=>a.relativePath.localeCompare(b.relativePath,"en-US"))),dataSchema:{minimumReadable:1,maximumReadable:2,target:2,backupRequired:true},artifacts:list,...overrides}; }
function envelope(m=manifest()){ const payload=Buffer.from(`BoxSpec Release Manifest v1\n${canonical(m)}`); return JSON.stringify({schemaVersion:1,keyId:"release-2026",manifest:m,signature:{algorithm:"ed25519",valueBase64:sign(null,payload,privateKey).toString("base64")}}); }
const installed={channel:"stable",version:"1.0.0",dataSchemaVersion:1};

function harness(options={}){
  let journal=null, active={selectionRef:"app-1.0.0",version:"1.0.0"}, reserved=false; const calls=[];
  const ports={
    journal:{load:async()=>journal,write:async(v)=>{journal=v;calls.push(`journal:${v.phase}`)}},
    history:{reserve:async()=>{if(options.replay||reserved)return "replay";reserved=true;return "reserved"}},
    staging:{prepare:async({manifest:m})=>{calls.push("prepare");return{selectionRef:"app-1.1.0",version:m.version}},inspectArtifact:async({artifact:a})=>options.partial&&a.role==="application-archive"?{sha256:"0".repeat(64),sizeBytes:a.sizeBytes}:{sha256:a.sha256,sizeBytes:a.sizeBytes},discard:async()=>{calls.push("discard")}},
    publisher:{verifyAuthenticode:async()=>({valid:true,subject:publisher.subject,certificateSha256:publisher.certificateSha256})},
    selection:{current:async()=>active,atomicSwitch:async({expected,next})=>{assert.deepEqual(active,expected);active=next;calls.push(`switch:${next.version}`)}},
    health:{check:async()=>({ok:options.health!==false,detail:"test health failure"})},
    schemaBackup:{create:async()=>{calls.push("backup");return"backup-1"},restore:async()=>{calls.push("restore")}},
    now:()=>new Date("2026-09-22T01:00:00.000Z"),transactionId:()=>"txn-1",
    fault:options.fault?async(point)=>{if(point===options.fault)throw new Error("crash")}:undefined,
  };
  return {updater:new TrustedUpdater(trust,ports),ports,calls,corruptJournal(){journal={...journal,checksum:"0".repeat(64)}},get journal(){return journal},get active(){return active}};
}
async function rejectsCode(action,code){await assert.rejects(action,(error)=>error instanceof UpdaterError&&error.code===code);}

test("commits only after complete hash, publisher, backup, switch, and health verification",async()=>{const h=harness();const result=await h.updater.apply(envelope(),installed);assert.equal(result.status,"COMMITTED");assert.equal(h.active.version,"1.1.0");assert.deepEqual(h.calls.slice(-4),["journal:ACTIVATING","switch:1.1.0","journal:HEALTH_PENDING","journal:COMMITTED"]);});
test("missing production trust and unsigned envelopes fail closed",async()=>{const h=harness();const none=new TrustedUpdater({keys:[],publishers:[]},h.ports);await rejectsCode(()=>none.apply(envelope(),installed),"MISSING_TRUST");await rejectsCode(()=>h.updater.apply(JSON.stringify({manifest:manifest()}),installed),"INVALID_MANIFEST");});
test("tampered signed content is rejected",async()=>{const signed=JSON.parse(envelope());signed.manifest.version="9.9.9";await rejectsCode(()=>harness().updater.apply(JSON.stringify(signed),installed),"SIGNATURE_INVALID");});
test("cross-channel and downgrade candidates are rejected",async()=>{const beta=manifest({channel:"beta",version:"1.1.0-beta.1"});await rejectsCode(()=>harness().updater.apply(envelope(beta),installed),"CHANNEL_MISMATCH");const old=manifest({version:"0.9.0"});await rejectsCode(()=>harness().updater.apply(envelope(old),installed),"VERSION_REJECTED");});
test("path traversal and reserved aliases are rejected inside a valid signature",async()=>{for(const bad of ["../BoxSpec.exe","resources/COM¹/file"]){const list=artifacts();list[5]={...list[5],relativePath:bad};await rejectsCode(()=>harness().updater.apply(envelope(manifest({artifacts:list})),installed),"INVALID_MANIFEST");}});
test("replayed release sequence is rejected before staging",async()=>{const h=harness({replay:true});await rejectsCode(()=>h.updater.apply(envelope(),installed),"REPLAY_REJECTED");assert.equal(h.calls.includes("prepare"),false);});
test("partial staging is rejected before selection",async()=>{const h=harness({partial:true});await rejectsCode(()=>h.updater.apply(envelope(),installed),"STAGING_MISMATCH");assert.equal(h.active.version,"1.0.0");assert.equal(h.journal.phase,"STAGING");});
test("failed health atomically restores selection and schema backup",async()=>{const h=harness({health:false});const result=await h.updater.apply(envelope(),installed);assert.equal(result.status,"ROLLED_BACK");assert.equal(h.active.version,"1.0.0");assert.deepEqual(h.calls.slice(-5),["journal:ROLLBACK_REQUIRED","switch:1.0.0","restore","discard","journal:ROLLED_BACK"]);});
test("crash after activation is recovered on restart",async()=>{const h=harness({fault:"after-selection"});await assert.rejects(()=>h.updater.apply(envelope(),installed),/crash/);assert.equal(h.active.version,"1.1.0");h.ports.fault=undefined;const result=await h.updater.recover();assert.equal(result.status,"ROLLED_BACK");assert.equal(h.active.version,"1.0.0");assert.equal(h.journal.phase,"ROLLED_BACK");});
test("invalid journal checksum blocks recovery without changing selection",async()=>{const h=harness({fault:"after-staging"});await assert.rejects(()=>h.updater.apply(envelope(),installed),/crash/);h.corruptJournal();await rejectsCode(()=>h.updater.recover(),"JOURNAL_INVALID");assert.equal(h.active.version,"1.0.0");});
