import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");

          if (normalizedId.includes("/node_modules/pdfjs-dist/")) {
            return "pdf";
          }

          if (normalizedId.includes("/node_modules/katex/")) {
            return "katex";
          }

          if (
            normalizedId.includes("/node_modules/react/") ||
            normalizedId.includes("/node_modules/react-dom/") ||
            normalizedId.includes("/node_modules/scheduler/")
          ) {
            return "react";
          }

          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "icons";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
