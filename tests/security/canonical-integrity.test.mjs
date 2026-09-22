import assert from "node:assert/strict";
import test from "node:test";

const shared = await import("../../packages/shared/dist/hashing.js");
const core = await import("../../packages/core/dist/index.js");

test("SEC-008: canonical key ordering is ordinal and independent of insertion order", () => {
  const first = { "é": 1, "z": 2, "ä": 3, "A": 4, "한": 5 };
  const second = { "한": 5, "A": 4, "ä": 3, "z": 2, "é": 1 };
  const expectedKeys = Object.keys(first).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(Object.keys(shared.canonicalizeJson(first)), expectedKeys);
  assert.equal(shared.canonicalJson(first), shared.canonicalJson(second));
  assert.equal(core.canonicalJson(first), shared.canonicalJson(first));
});

test("complete source manifest hash binds executable metadata and exact path", async () => {
  const base = [{ path: "src/App.tsx", kind: "file", sha256: "a".repeat(64), sizeBytes: 10, executable: false }];
  const reordered = [
    { path: "src/z.ts", kind: "file", sha256: "b".repeat(64), sizeBytes: 4, executable: false },
    ...base,
  ];
  const reverse = [...reordered].reverse();
  assert.equal(await shared.hashSourceManifest(reordered), await shared.hashSourceManifest(reverse));
  assert.notEqual(
    await shared.hashSourceManifest(base),
    await shared.hashSourceManifest([{ ...base[0], executable: true }]),
  );
  assert.notEqual(
    await shared.hashSourceManifest(base),
    await shared.hashSourceManifest([{ ...base[0], path: "src/app.tsx" }]),
  );
});

