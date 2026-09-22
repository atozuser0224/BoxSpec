import type { DesignToken, LayoutContract } from "@boxspec/shared/contracts";
import type { ThemeId } from "@boxspec/shared/domain";
import type { ThemeGalleryItem } from "@boxspec/shared/runtime";

export type { ThemeId, ThemeGalleryItem };
export type ThemeMode = "light" | "dark" | "mixed";
export interface ThemeSource {
  readonly collection: string;
  readonly title: string;
  readonly url: string;
  readonly originalUrl: string;
  readonly retrievedAt: string;
  readonly previewUrl?: string;
  readonly licenseNote: string;
}
export type ThemePreview =
  | { readonly kind: "local"; readonly path: string; readonly alt: string; readonly credit: string }
  | { readonly kind: "remote-fallback"; readonly url: string; readonly alt: string; readonly credit: string };
export interface ThemePreset {
  readonly schemaVersion: "1.0.0";
  readonly id: ThemeId;
  readonly name: string;
  readonly summary: string;
  readonly category: string;
  readonly styleTags: readonly string[];
  readonly mode: ThemeMode;
  readonly source: ThemeSource;
  readonly preview: ThemePreview;
  readonly tokens: Readonly<Record<string, DesignToken>>;
  readonly palette: readonly { readonly hex: string; readonly role: string }[];
  readonly typography: { readonly displayHint: string; readonly bodyHint: string };
  readonly interpretation: {
    readonly density: string;
    readonly radius: string;
    readonly shadow: string;
    readonly motion: string;
    readonly notes: readonly string[];
  };
}
export interface ThemeCatalog { readonly schemaVersion: "1.0.0"; readonly generatedAt: string; readonly themes: readonly ThemePreset[] }
export interface ThemeContext {
  readonly schemaVersion: "1.0.0";
  readonly themeId: ThemeId;
  readonly name: string;
  readonly mode: ThemeMode;
  readonly styleTags: readonly string[];
  readonly sourceUrl: string;
  readonly tokens: Readonly<Record<string, DesignToken>>;
  readonly interpretation: ThemePreset["interpretation"];
}
export interface ThemeApplicationResult {
  readonly contract: LayoutContract;
  readonly themeId: ThemeId;
  readonly changedTokenNames: readonly string[];
  readonly designSystemRevision: number;
  readonly contractRevisionMode: "preserved-draft" | "incremented-contract";
  readonly beforeContractHash: string;
  readonly afterContractHash: string;
}
