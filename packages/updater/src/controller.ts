import { UpdaterError } from "./errors.js";
import { parseJournal, sealJournal, updateJournal } from "./journal.js";
import { assessRelease, verifyReleaseEnvelope } from "./manifest.js";
import type { ActiveSelection, InstalledState, UpdateJournal, UpdateResult, UpdaterPorts, UpdaterTrust, VerifiedRelease } from "./types.js";

export class TrustedUpdater {
  public constructor(private readonly trust: UpdaterTrust, private readonly ports: UpdaterPorts) {}

  public verify(rawEnvelope: string, installed: InstalledState): VerifiedRelease {
    const release = verifyReleaseEnvelope(rawEnvelope, this.trust, this.ports.now());
    assessRelease(release, installed);
    return release;
  }

  public async apply(rawEnvelope: string, installed: InstalledState): Promise<UpdateResult> {
    const existing = await this.ports.journal.load();
    if (existing !== null) {
      const journal = parseJournal(existing);
      if (journal.phase !== "COMMITTED" && journal.phase !== "ROLLED_BACK") throw new UpdaterError("RECOVERY_BLOCKED", "an unfinished update must be recovered first");
    }
    const release = this.verify(rawEnvelope, installed);
    const current = await this.ports.selection.current();
    if (current.version !== installed.version) throw new UpdaterError("VERSION_REJECTED", "installed state does not match active selection");
    const transactionId = this.ports.transactionId();
    const reservation = await this.ports.history.reserve({ channel: release.manifest.channel, sequence: release.manifest.sequence, releaseId: release.manifest.releaseId, manifestDigest: release.manifestDigest });
    if (reservation !== "reserved") throw new UpdaterError("REPLAY_REJECTED", `release history rejected candidate: ${reservation}`);
    let journal = sealJournal({ schemaVersion:1, transactionId, phase:"PREPARING", manifestDigest:release.manifestDigest, releaseId:release.manifest.releaseId, channel:release.manifest.channel, sequence:release.manifest.sequence, version:release.manifest.version, previousSelection:current, nextSelection:null, previousDataSchema:installed.dataSchemaVersion, targetDataSchema:release.manifest.dataSchema.target, backupRef:null });
    await this.ports.journal.write(journal); await this.ports.fault?.("after-preparing");
    const next = await this.ports.staging.prepare({ transactionId, manifest:release.manifest });
    if (next.version !== release.manifest.version) throw new UpdaterError("STAGING_MISMATCH", "staging returned a different version");
    journal = updateJournal(journal,{phase:"STAGING",nextSelection:next}); await this.ports.journal.write(journal); await this.ports.fault?.("after-staging");
    await this.verifyStage(transactionId, release);
    if (journal.targetDataSchema !== journal.previousDataSchema) {
      const backupRef = await this.ports.schemaBackup.create({ transactionId, currentSchema:journal.previousDataSchema, targetSchema:journal.targetDataSchema });
      journal=updateJournal(journal,{backupRef}); await this.ports.journal.write(journal);
    }
    journal=updateJournal(journal,{phase:"STAGED_VERIFIED"}); await this.ports.journal.write(journal); await this.ports.fault?.("after-verified");
    journal=updateJournal(journal,{phase:"ACTIVATING"}); await this.ports.journal.write(journal);
    await this.ports.selection.atomicSwitch({expected:current,next});
    journal=updateJournal(journal,{phase:"HEALTH_PENDING"}); await this.ports.journal.write(journal); await this.ports.fault?.("after-selection");
    const health = await this.ports.health.check({selection:next,manifestDigest:release.manifestDigest,executableRelativePath:"BoxSpec.exe"});
    if (!health.ok) return this.rollback(journal, health.detail ?? "health check failed");
    journal=updateJournal(journal,{phase:"COMMITTED"}); await this.ports.journal.write(journal);
    return {status:"COMMITTED",version:journal.version,transactionId};
  }

  public async recover(): Promise<UpdateResult | null> {
    const raw=await this.ports.journal.load(); if(raw===null) return null;
    const journal=parseJournal(raw);
    if(journal.phase==="COMMITTED") return {status:"COMMITTED",version:journal.version,transactionId:journal.transactionId};
    if(journal.phase==="ROLLED_BACK") return {status:"ROLLED_BACK",version:journal.version,transactionId:journal.transactionId,reason:"already rolled back"};
    return this.rollback(journal,"recovered unfinished update");
  }

  private async verifyStage(transactionId:string, release:VerifiedRelease):Promise<void> {
    for(const artifact of release.manifest.artifacts){
      const actual=await this.ports.staging.inspectArtifact({transactionId,artifact});
      if(actual.sha256!==artifact.sha256 || actual.sizeBytes!==artifact.sizeBytes) throw new UpdaterError("STAGING_MISMATCH",`staged artifact mismatch: ${artifact.relativePath}`);
      if(artifact.publisherId!==null){ const expected=this.trust.publishers.find((p)=>p.publisherId===artifact.publisherId)!; const actualPublisher=await this.ports.publisher.verifyAuthenticode({transactionId,artifact}); if(!actualPublisher.valid || actualPublisher.subject!==expected.subject || actualPublisher.certificateSha256!==expected.certificateSha256) throw new UpdaterError("PUBLISHER_MISMATCH",`publisher mismatch: ${artifact.relativePath}`); }
    }
  }

  private async rollback(input:UpdateJournal, reason:string):Promise<UpdateResult>{
    let journal=input.phase==="ROLLBACK_REQUIRED"?input:updateJournal(input,{phase:"ROLLBACK_REQUIRED"});
    await this.ports.journal.write(journal);
    const current=await this.ports.selection.current();
    const onPrevious=equal(current,journal.previousSelection), onNext=journal.nextSelection!==null&&equal(current,journal.nextSelection);
    if(!onPrevious&&!onNext) throw new UpdaterError("RECOVERY_BLOCKED","active selection is neither journaled version");
    const mayHaveMigrated=onNext || input.phase==="HEALTH_PENDING" || input.phase==="ROLLBACK_REQUIRED";
    if(onNext) await this.ports.selection.atomicSwitch({expected:current,next:journal.previousSelection});
    if(mayHaveMigrated&&journal.backupRef!==null) await this.ports.schemaBackup.restore({backupRef:journal.backupRef,expectedSchema:journal.previousDataSchema});
    await this.ports.staging.discard(journal.transactionId);
    journal=updateJournal(journal,{phase:"ROLLED_BACK"}); await this.ports.journal.write(journal);
    return {status:"ROLLED_BACK",version:journal.version,transactionId:journal.transactionId,reason};
  }
}
function equal(a:ActiveSelection,b:ActiveSelection):boolean{return a.selectionRef===b.selectionRef&&a.version===b.version;}
