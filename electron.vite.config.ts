import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

function isolateWorkerEmbed() {
  return {
    name: "isolate-worker-embed",
    enforce: "pre" as const,
    resolveId(id: string, importer?: string): string | undefined {
      if (!importer?.replace(/\\/g, "/").endsWith("/src/main/voiceprint/worker.ts")) return;
      if (id !== "./embed.ts" && !id.endsWith("/embed.ts")) return;
      return `${resolve("src/main/voiceprint/embed.ts")}?worker-inline`;
    },
  };
}

export default defineConfig({
  main: {
    define: { "process.env.NODE_ENV_ELECTRON_VITE": JSON.stringify(process.env.NODE_ENV_ELECTRON_VITE ?? "production") },
    plugins: [externalizeDepsPlugin(), isolateWorkerEmbed()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "voiceprint-worker": resolve("src/main/voiceprint/worker.ts"),
          "dictation-pasteboard-worker": resolve("src/main/dictation/pasteboard-worker.ts"),
        },
        external: ["sherpa-onnx-node", "node-mac-permissions", "koffi"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          capture: resolve("src/preload/capture.ts"),
          "dictation-capture": resolve("src/preload/dictation-capture.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          capture: resolve("src/renderer/capture.html"),
          "dictation-capture": resolve("src/renderer/dictation-capture.html"),
        },
      },
    },
  },
});
