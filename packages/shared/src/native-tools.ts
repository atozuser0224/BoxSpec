export interface NativeToolManifest {
  readonly protocol: number;
  readonly developmentRelativePath: string;
  /** Path relative to the packaged application directory (dirname(process.execPath)). */
  readonly packagedRelativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly invocationArgs: readonly string[];
}

/** Single trusted identity for the Windows safe-filesystem helper. */
export const NATIVE_SAFE_FS_MANIFEST = {
  protocol: 1,
  developmentRelativePath: "crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe",
  packagedRelativePath: "resources/native/boxspec-safe-fs.exe",
  sha256: "13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8",
  sizeBytes: 67_548_236,
  invocationArgs: ["--protocol", "1"],
} as const satisfies NativeToolManifest;
