import assert from "node:assert/strict";
import test from "node:test";

const paths = await import("../../packages/change-manager/dist/path-safety.js");

const rejected = [
  "../escape.ts",
  "a/../../escape.ts",
  "./ambiguous.ts",
  "/absolute.ts",
  "\\absolute.ts",
  "C:\\absolute.ts",
  "C:drive-relative.ts",
  "\\\\server\\share\\file.ts",
  "\\\\?\\C:\\device.ts",
  "\\\\.\\pipe\\name",
  "file.ts:secret",
  "file.ts::$DATA",
  "trailing-dot.",
  "trailing-space ",
  "CON",
  "con.txt",
  "NUL.js",
  "COM1.log",
  "LPT9",
  "COM\u00b2.txt",
  "LPT\u00b3.txt",
  "wild*.ts",
  "what?.ts",
];

for (const candidate of rejected) {
  test(`reject unsafe Windows path: ${JSON.stringify(candidate)}`, () => {
    assert.throws(() => paths.normalizeRelativePath(candidate));
  });
}

test("accept ordinary Korean and space-containing relative path byte-for-byte", () => {
  assert.equal(paths.normalizeRelativePath("src/화면 구성/패널.tsx"), "src/화면 구성/패널.tsx");
});

test("scope matching does not accept sibling prefix", () => {
  assert.equal(paths.pathMatchesScope("src/ui/button.tsx", ["src/ui/"]), true);
  assert.equal(paths.pathMatchesScope("src/ui-evil/button.tsx", ["src/ui/"]), false);
});

test("Windows collision key catches case and NFC aliases", () => {
  assert.equal(paths.windowsCollisionKey("SRC/UI/Button.tsx"), paths.windowsCollisionKey("src/ui/button.tsx"));
  assert.equal(paths.windowsCollisionKey("src/cafe\u0301.tsx"), paths.windowsCollisionKey("src/caf\u00e9.tsx"));
});

