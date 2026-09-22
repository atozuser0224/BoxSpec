import { pathToFileURL } from "node:url";

export interface RendererUrlOptions {
  packaged: boolean;
  developmentUrl?: string;
  rendererHtmlPath: string;
}

export function resolveTrustedRendererUrl(options: RendererUrlOptions): URL {
  if (!options.packaged && options.developmentUrl) {
    const parsed = new URL(options.developmentUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new Error("BOXSPEC_RENDERER_URL must be an http://127.0.0.1 development URL.");
    }
    return parsed;
  }
  return pathToFileURL(options.rendererHtmlPath);
}
