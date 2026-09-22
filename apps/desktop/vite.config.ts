import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function developmentCsp(): Plugin {
  return {
    name: "boxspec-development-csp",
    transformIndexHtml(html) {
      return html.replace(
        "connect-src 'self';",
        "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173;",
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === "serve" ? [developmentCsp()] : [])],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
}));
