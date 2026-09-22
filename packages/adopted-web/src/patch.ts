import { AdoptedWebError } from "./errors.js";
import { contentHash } from "./hash.js";
import { validateSourceInput } from "./input.js";
import type { AdoptedPatchProposal, AdoptedWebSourceInput, MaterializedPatch, PatchEdit } from "./types.js";

function validateEdit(edit: PatchEdit, contentLength: number): void {
  if (!Number.isInteger(edit.start) || edit.start < 0 || edit.start > contentLength || edit.deleteLength !== 0 ||
      !edit.insertText.startsWith(" data-boxspec-id=")) {
    throw new AdoptedWebError("INVALID_INPUT", "Patch proposal contains a non-attribute or out-of-bounds edit", { templateNodeId: edit.templateNodeId });
  }
}

export function materializeAdoptedPatch(input: AdoptedWebSourceInput, proposal: AdoptedPatchProposal): MaterializedPatch {
  validateSourceInput(input);
  if (proposal.sourceId !== input.sourceId || proposal.fileName !== input.fileName) {
    throw new AdoptedWebError("CONTEXT_NOT_APPROVED", "Patch proposal targets a different approved source", { proposalId: proposal.proposalId });
  }
  const actualHash = contentHash(input.content);
  if (actualHash !== proposal.baseContentHash) {
    throw new AdoptedWebError("SOURCE_STALE", "Source changed after the patch proposal was created", {
      expectedContentHash: proposal.baseContentHash,
      actualContentHash: actualHash,
    });
  }
  let previousStart = -1;
  for (const edit of proposal.edits) {
    validateEdit(edit, input.content.length);
    if (edit.start <= previousStart) throw new AdoptedWebError("INVALID_INPUT", "Patch edits must be strictly ordered and non-overlapping");
    previousStart = edit.start;
  }
  let output = input.content;
  for (const edit of [...proposal.edits].reverse()) output = output.slice(0, edit.start) + edit.insertText + output.slice(edit.start);
  const resultHash = contentHash(output);
  if (resultHash !== proposal.proposedContentHash) {
    throw new AdoptedWebError("SOURCE_STALE", "Materialized patch hash does not match the review proposal", {
      expectedContentHash: proposal.proposedContentHash,
      actualContentHash: resultHash,
    });
  }
  return { sourceId: input.sourceId, content: output, contentHash: resultHash };
}
