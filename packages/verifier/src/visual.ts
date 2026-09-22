import { inflateSync } from "node:zlib";
import { hashCanonical, sha256Bytes } from "./hash.js";
import type { Violation } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface VisualBinding {
  readonly effectiveContractHash: string;
  readonly verificationProfileHash: string;
  readonly fixturesHash: string;
  readonly viewportId: string;
  readonly fixtureId: string;
}

export interface TrustedVisualBaseline {
  readonly baselineId: string;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly binding: VisualBinding;
  readonly imageSha256: string;
  /** Hash of the descriptor fields other than imageBytes and descriptorHash. */
  readonly descriptorHash: string;
  readonly imageBytes: Uint8Array;
}

export interface VisualIgnoreRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisualComparisonOptions {
  /** Per-channel delta in the inclusive range 0..255. */
  readonly maxChannelDelta?: number;
  /** Maximum changed-pixel ratio in the inclusive range 0..1. */
  readonly maxChangedPixelRatio?: number;
  /** Trusted profile-owned regions where pure pixel comparison is disabled. */
  readonly ignoreRegions?: readonly VisualIgnoreRegion[];
}

export interface VisualDifferenceMeasurement {
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly comparedPixels: number;
  readonly ignoredPixels: number;
  readonly changedPixels: number;
  readonly changedPixelRatio: number;
  readonly maximumChannelDelta: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly differenceBounds: Readonly<{ x: number; y: number; width: number; height: number }> | null;
}

export interface VisualComparisonResult {
  readonly status: "PASS" | "FAIL" | "UNSUPPORTED" | "ERROR" | "STALE";
  readonly binding: VisualBinding;
  readonly bindingDigest: string;
  readonly baselineId: string | null;
  readonly baselineImageSha256: string | null;
  readonly actualImageSha256: string;
  readonly optionsDigest: string;
  readonly measurement: VisualDifferenceMeasurement | null;
  readonly violations: readonly Violation[];
  readonly message: string;
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

class UnsupportedPngError extends Error {}

function validateBinding(binding: VisualBinding): void {
  if (!binding.viewportId || !binding.fixtureId) throw new TypeError("Visual binding viewportId and fixtureId are required");
  if (!SHA256.test(binding.effectiveContractHash) || !SHA256.test(binding.verificationProfileHash) || !SHA256.test(binding.fixturesHash)) {
    throw new TypeError("Visual binding hashes must be lowercase SHA-256 values");
  }
}

export function computeApprovedVisualBaselineDescriptorHash(
  baseline: Omit<TrustedVisualBaseline, "descriptorHash" | "imageBytes">,
): string {
  return hashCanonical({
    baselineId: baseline.baselineId,
    approvalId: baseline.approvalId,
    approvedAt: baseline.approvedAt,
    binding: baseline.binding,
    imageSha256: baseline.imageSha256,
  });
}

function readChunks(bytes: Uint8Array): { ihdr: Buffer; idat: Buffer[] } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength < PNG_SIGNATURE.byteLength || !buffer.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new UnsupportedPngError("Visual engine supports trusted PNG captures only");
  }
  let offset = PNG_SIGNATURE.byteLength;
  let ihdr: Buffer | undefined;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.byteLength) throw new UnsupportedPngError("PNG chunk exceeds image bounds");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  if (!ihdr || ihdr.byteLength !== 13 || idat.length === 0) throw new UnsupportedPngError("PNG is missing required IHDR or IDAT data");
  return { ihdr, idat };
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  const { ihdr, idat } = readChunks(bytes);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (width === 0 || height === 0 || width > 16_384 || height > 16_384) throw new UnsupportedPngError("PNG dimensions are outside the trusted visual-engine limit");
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new UnsupportedPngError("Visual engine requires non-interlaced 8-bit PNG captures");
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new UnsupportedPngError(`Visual engine does not support PNG color type ${String(colorType)}`);
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  if (inflated.byteLength !== (stride + 1) * height) throw new UnsupportedPngError("PNG decompressed size does not match its dimensions");
  const raw = new Uint8Array(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset++];
    if (filter === undefined || filter > 4) throw new UnsupportedPngError("PNG uses an unsupported row filter");
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = inflated[sourceOffset++];
      if (encoded === undefined) throw new UnsupportedPngError("PNG row data ended unexpectedly");
      const left = x >= channels ? raw[rowOffset + x - channels]! : 0;
      const up = y > 0 ? raw[rowOffset - stride + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? raw[rowOffset - stride + x - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      raw[rowOffset + x] = (encoded + predictor) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const inputOffset = pixel * channels;
    const outputOffset = pixel * 4;
    if (colorType === 6) {
      rgba.set(raw.subarray(inputOffset, inputOffset + 4), outputOffset);
    } else if (colorType === 2) {
      rgba[outputOffset] = raw[inputOffset]!;
      rgba[outputOffset + 1] = raw[inputOffset + 1]!;
      rgba[outputOffset + 2] = raw[inputOffset + 2]!;
      rgba[outputOffset + 3] = 255;
    } else if (colorType === 4) {
      rgba[outputOffset] = raw[inputOffset]!;
      rgba[outputOffset + 1] = raw[inputOffset]!;
      rgba[outputOffset + 2] = raw[inputOffset]!;
      rgba[outputOffset + 3] = raw[inputOffset + 1]!;
    } else {
      rgba[outputOffset] = raw[inputOffset]!;
      rgba[outputOffset + 1] = raw[inputOffset]!;
      rgba[outputOffset + 2] = raw[inputOffset]!;
      rgba[outputOffset + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function normalizeOptions(options: VisualComparisonOptions): Required<VisualComparisonOptions> {
  const maxChannelDelta = options.maxChannelDelta ?? 0;
  const maxChangedPixelRatio = options.maxChangedPixelRatio ?? 0;
  const ignoreRegions = options.ignoreRegions ?? [];
  if (!Number.isInteger(maxChannelDelta) || maxChannelDelta < 0 || maxChannelDelta > 255) throw new TypeError("maxChannelDelta must be an integer from 0 through 255");
  if (!Number.isFinite(maxChangedPixelRatio) || maxChangedPixelRatio < 0 || maxChangedPixelRatio > 1) throw new TypeError("maxChangedPixelRatio must be from 0 through 1");
  for (const region of ignoreRegions) {
    if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
      throw new TypeError("Visual ignore regions must use positive integer dimensions and non-negative origins");
    }
  }
  return { maxChannelDelta, maxChangedPixelRatio, ignoreRegions };
}

function ignored(x: number, y: number, regions: readonly VisualIgnoreRegion[]): boolean {
  return regions.some((region) => x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height);
}

function difference(baseline: DecodedPng, actual: DecodedPng, options: Required<VisualComparisonOptions>): VisualDifferenceMeasurement {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      width: actual.width,
      height: actual.height,
      totalPixels: actual.width * actual.height,
      comparedPixels: 0,
      ignoredPixels: 0,
      changedPixels: actual.width * actual.height,
      changedPixelRatio: 1,
      maximumChannelDelta: 255,
      meanAbsoluteChannelDelta: 255,
      differenceBounds: { x: 0, y: 0, width: actual.width, height: actual.height },
    };
  }
  let comparedPixels = 0;
  let ignoredPixels = 0;
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  let absoluteDeltaTotal = 0;
  let minX = actual.width;
  let minY = actual.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      if (ignored(x, y, options.ignoreRegions)) {
        ignoredPixels += 1;
        continue;
      }
      comparedPixels += 1;
      const offset = (y * actual.width + x) * 4;
      let pixelMaximum = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(actual.rgba[offset + channel]! - baseline.rgba[offset + channel]!);
        absoluteDeltaTotal += delta;
        pixelMaximum = Math.max(pixelMaximum, delta);
        maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      }
      if (pixelMaximum > options.maxChannelDelta) {
        changedPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    width: actual.width,
    height: actual.height,
    totalPixels: actual.width * actual.height,
    comparedPixels,
    ignoredPixels,
    changedPixels,
    changedPixelRatio: comparedPixels === 0 ? 0 : changedPixels / comparedPixels,
    maximumChannelDelta,
    meanAbsoluteChannelDelta: comparedPixels === 0 ? 0 : absoluteDeltaTotal / (comparedPixels * 4),
    differenceBounds: changedPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

export function compareVisual(
  actual: Uint8Array,
  baseline: TrustedVisualBaseline | null | undefined,
  binding: VisualBinding,
  rawOptions: VisualComparisonOptions = {},
): VisualComparisonResult {
  validateBinding(binding);
  const options = normalizeOptions(rawOptions);
  const bindingDigest = hashCanonical(binding);
  const optionsDigest = hashCanonical(options);
  const actualImageSha256 = sha256Bytes(actual);
  const base = { binding, bindingDigest, actualImageSha256, optionsDigest } as const;
  if (!baseline) {
    return {
      ...base,
      status: "UNSUPPORTED",
      baselineId: null,
      baselineImageSha256: null,
      measurement: null,
      violations: [],
      message: "No trusted approved visual baseline was supplied",
    };
  }
  const baselineIdentity = { baselineId: baseline.baselineId, baselineImageSha256: baseline.imageSha256 } as const;
  if (!baseline.baselineId || !baseline.approvalId || !baseline.approvedAt || !SHA256.test(baseline.imageSha256) || !SHA256.test(baseline.descriptorHash)) {
    return { ...base, ...baselineIdentity, status: "STALE", measurement: null, violations: [], message: "Approved baseline descriptor is incomplete or malformed" };
  }
  const computedDescriptorHash = computeApprovedVisualBaselineDescriptorHash(baseline);
  const baselineBytesHash = sha256Bytes(baseline.imageBytes);
  if (baseline.descriptorHash !== computedDescriptorHash || baseline.imageSha256 !== baselineBytesHash || hashCanonical(baseline.binding) !== bindingDigest) {
    return {
      ...base,
      ...baselineIdentity,
      status: "STALE",
      measurement: null,
      violations: [{
        id: `visual:${binding.viewportId}:${binding.fixtureId}:baseline-binding`,
        checkId: "visual",
        kind: "approved-baseline-stale",
        severity: "error",
        blocking: true,
        message: "Approved baseline bytes, descriptor seal, or environment binding do not match trusted inputs",
        viewportId: binding.viewportId,
        fixtureId: binding.fixtureId,
        expected: { descriptorHash: computedDescriptorHash, imageSha256: baselineBytesHash, bindingDigest },
        actual: { descriptorHash: baseline.descriptorHash, imageSha256: baseline.imageSha256, bindingDigest: hashCanonical(baseline.binding) },
      }],
      message: "Approved visual baseline is stale or tampered",
    };
  }
  try {
    const measurement = difference(decodePng(baseline.imageBytes), decodePng(actual), options);
    const failed = measurement.comparedPixels === 0 || measurement.changedPixelRatio > options.maxChangedPixelRatio;
    const violations: Violation[] = failed
      ? [{
          id: `visual:${binding.viewportId}:${binding.fixtureId}:pixel-difference`,
          checkId: "visual",
          kind: measurement.comparedPixels === 0 ? "no-comparable-pixels" : "pixel-regression",
          severity: "error",
          blocking: true,
          message:
            measurement.comparedPixels === 0
              ? "Trusted visual mask excludes every pixel"
              : `${measurement.changedPixels} pixel(s) changed (${(measurement.changedPixelRatio * 100).toFixed(4)}%)`,
          viewportId: binding.viewportId,
          fixtureId: binding.fixtureId,
          expected: { maxChangedPixelRatio: options.maxChangedPixelRatio, maxChannelDelta: options.maxChannelDelta },
          actual: measurement,
        }]
      : [];
    return {
      ...base,
      ...baselineIdentity,
      status: failed ? "FAIL" : "PASS",
      measurement,
      violations,
      message: failed ? violations[0]!.message : `${measurement.comparedPixels} pixel(s) match the approved baseline within trusted thresholds`,
    };
  } catch (error) {
    const unsupported = error instanceof UnsupportedPngError;
    return {
      ...base,
      ...baselineIdentity,
      status: unsupported ? "UNSUPPORTED" : "ERROR",
      measurement: null,
      violations: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
