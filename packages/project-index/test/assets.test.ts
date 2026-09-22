import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAssetIndex, ProjectIndexError } from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted project asset index", () => {
  it("indexes approved folders with content identity and preserves same-name collisions", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "assets", "brand"), { recursive: true });
    await mkdir(join(root, "assets", "product"), { recursive: true });
    await writeFile(join(root, "assets", "brand", "logo.png"), png("brand"));
    await writeFile(join(root, "assets", "product", "logo.png"), png("product"));
    await writeFile(join(root, "assets", "notes.txt"), "not an indexed asset", "utf8");

    const index = await ProjectAssetIndex.build({
      rootPath: root,
      indexRevision: 1,
      approvedFolders: [{
        relativePath: "assets",
        metadata: {
          "brand/logo.png": {
            license: { spdxId: "MIT", notice: "Project-owned brand fixture" },
            thumbnailArtifactId: "thumbnail_brand_logo"
          }
        }
      }]
    });

    expect(index.records).toHaveLength(2);
    expect(index.skippedUnsupportedFiles).toBe(1);
    const matches = index.search("logo");
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((record) => record.assetId)).size).toBe(2);
    expect(matches.every((record) => record.nameCollision)).toBe(true);
    expect(matches.map((record) => record.relativePath)).toEqual([
      "assets/brand/logo.png",
      "assets/product/logo.png"
    ]);
    const branded = matches[0]!;
    expect(branded).toMatchObject({
      mimeType: "image/png",
      source: { kind: "project-file", approvedFolder: "assets" },
      license: { status: "declared", spdxId: "MIT" },
      thumbnailArtifactId: "thumbnail_brand_logo"
    });
    const content = await index.read({ assetId: branded.assetId, expectedSha256: branded.sha256 });
    expect(Buffer.from(content.bytes)).toEqual(png("brand"));
  });

  it("rejects traversal, absolute, and foreign-root approved folders", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "assets"));
    for (const relativePath of ["../outside", "C:/outside", "/outside", "assets/../outside"]) {
      await expect(ProjectAssetIndex.build({ rootPath: root, indexRevision: 1, approvedFolders: [{ relativePath }] }))
        .rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
    }
  });

  it("rejects junctions or directory symlinks inside an approved folder", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await mkdir(join(root, "assets"));
    await mkdir(join(outside, "foreign"));
    await writeFile(join(outside, "foreign", "outside.png"), png("outside"));
    await symlink(join(outside, "foreign"), join(root, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(ProjectAssetIndex.build({ rootPath: root, indexRevision: 1, approvedFolders: [{ relativePath: "assets" }] }))
      .rejects.toMatchObject({ code: "ALIAS_REJECTED" });
  });

  it("refuses a stale content-bound read after the file changes", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "assets"));
    const assetPath = join(root, "assets", "icon.png");
    await writeFile(assetPath, png("before"));
    const index = await ProjectAssetIndex.build({ rootPath: root, indexRevision: 1, approvedFolders: [{ relativePath: "assets" }] });
    const record = index.records[0]!;
    await writeFile(assetPath, png("after"));

    await expect(index.read({ assetId: record.assetId, expectedSha256: record.sha256 }))
      .rejects.toMatchObject({ code: "ASSET_CHANGED" });
    await expect(index.read({ assetId: record.assetId, expectedSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "ASSET_CHANGED" });
  });

  it("rejects unbound metadata instead of attaching it to a same-named asset", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "logo.png"), png("logo"));

    await expect(ProjectAssetIndex.build({
      rootPath: root,
      indexRevision: 1,
      approvedFolders: [{
        relativePath: "assets",
        metadata: { "elsewhere/logo.png": { license: { spdxId: "MIT" } } }
      }]
    })).rejects.toBeInstanceOf(ProjectIndexError);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boxspec-project-index-"));
  temporaryRoots.push(root);
  return root;
}

function png(label: string): Buffer {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label, "utf8")]);
}
