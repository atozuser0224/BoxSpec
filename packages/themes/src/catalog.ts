import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ThemeId } from "@boxspec/shared/domain";
import { ThemeError } from "./errors.js";
import { toThemeGalleryItem } from "./gallery.js";
import type { ThemeCatalog, ThemeGalleryItem, ThemePreset } from "./types.js";
import { findThemePreset, loadThemeCatalog } from "./validation.js";

const PACKAGE_ROOT = new URL("../", import.meta.url);
const CATALOG_URL = new URL("catalog/themes.json", PACKAGE_ROOT);
let trustedCatalog: ThemeCatalog | undefined;

function readTrustedCatalog(): ThemeCatalog {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as unknown;
  } catch (error) {
    throw new ThemeError("THEME_CATALOG_INVALID", "The packaged theme catalog could not be read", [{
      path: "/catalog/themes.json",
      code: "CATALOG_READ_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  const catalog = loadThemeCatalog(input);
  for (const theme of catalog.themes) {
    if (theme.preview.kind !== "local") continue;
    const previewUrl = new URL(theme.preview.path, PACKAGE_ROOT);
    const packagePath = fileURLToPath(PACKAGE_ROOT);
    const previewPath = fileURLToPath(previewUrl);
    if (!previewPath.startsWith(packagePath) || !existsSync(previewUrl)) {
      throw new ThemeError("THEME_CATALOG_INVALID", `Local preview for theme '${theme.id}' is unavailable`, [{
        path: `/themes/${theme.id}/preview/path`,
        code: "PREVIEW_NOT_FOUND",
        message: theme.preview.path,
      }]);
    }
  }
  return catalog;
}

/** Returns the strictly validated catalog installed with this package. */
export function getThemeCatalog(): ThemeCatalog {
  trustedCatalog ??= readTrustedCatalog();
  return trustedCatalog;
}

/** Resolves a renderer-supplied id against the package-owned catalog. */
export function getThemePreset(themeId: ThemeId): ThemePreset {
  return findThemePreset(getThemeCatalog(), themeId);
}

/** Returns the renderer-safe projection of the package-owned catalog. */
export function getThemeGallery(): readonly ThemeGalleryItem[] {
  return getThemeCatalog().themes.map(toThemeGalleryItem);
}
