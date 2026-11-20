import { configurationContent } from "./configuration-plugin.ts";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [configurationContent(), {
    name: "appearance-init",
    transformIndexHtml() {
      return [{ tag: "script", children: readFileSync(new URL("../../src/ui/theme-init.js", import.meta.url), "utf8"), injectTo: "head-prepend" }];
    },
  }],
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/chat-assets/",
  build: {
    outDir: "../../dist/chat",
    emptyOutDir: true,
    assetsDir: "",
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      onwarn(warning, handler) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        handler(warning);
      },
    },
  },
});
