import { AdoptedWebError } from "./errors.js";
import type { AdoptedWebSourceInput } from "./types.js";

const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function required(value: string, field: string): void {
  if (!ID.test(value)) throw new AdoptedWebError("INVALID_INPUT", field + " is invalid", { field });
}

export function validateSourceInput(input: AdoptedWebSourceInput): void {
  required(input.sourceId, "sourceId");
  required(input.approvedContext.projectId, "approvedContext.projectId");
  required(input.approvedContext.screenId, "approvedContext.screenId");
  required(input.approvedContext.approvalId, "approvedContext.approvalId");
  if (!input.approvedContext.allowedSourceIds.includes(input.sourceId)) {
    throw new AdoptedWebError("CONTEXT_NOT_APPROVED", "Source is outside the approved analysis context", { sourceId: input.sourceId });
  }
  if (input.fileName.length === 0 || input.fileName.length > 512 || input.fileName.includes("\0")) {
    throw new AdoptedWebError("INVALID_INPUT", "fileName must be a bounded source label", { field: "fileName" });
  }
  const expectedExtension = input.language === "tsx" ? ".tsx" : ".jsx";
  if (!input.fileName.toLowerCase().endsWith(expectedExtension)) {
    throw new AdoptedWebError("INVALID_INPUT", "fileName does not match the declared JSX language", { expectedExtension });
  }
  if (input.content.length === 0 || Buffer.byteLength(input.content, "utf8") > 2_000_000 || input.content.includes("\0")) {
    throw new AdoptedWebError("INVALID_INPUT", "Source content must be non-empty UTF-8 text no larger than 2 MB", { field: "content" });
  }
  const viewport = input.approvedContext.viewport;
  if (!Number.isInteger(viewport.width) || viewport.width < 240 || viewport.width > 7680 ||
      !Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 4320 ||
      !Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor < 0.5 || viewport.deviceScaleFactor > 4) {
    throw new AdoptedWebError("INVALID_INPUT", "Viewport is outside the supported declaration bounds", { field: "approvedContext.viewport" });
  }
  if (input.approvedContext.testedStates.length === 0 || input.approvedContext.testedStates.length > 32 ||
      input.approvedContext.testedStates.some((state) => state.trim().length === 0 || state.length > 128)) {
    throw new AdoptedWebError("INVALID_INPUT", "At least one bounded intended test state is required", { field: "approvedContext.testedStates" });
  }
}
