import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// `pnpm demo`: the app on a scripted model. See test/e2e/wrangler.jsonc.
export default defineConfig({
  root: path.resolve(import.meta.dirname, "../.."),
  plugins: [
    agents(),
    react(),
    cloudflare({
      configPath: path.resolve(import.meta.dirname, "wrangler.jsonc"),
      // Its own state, apart from `pnpm dev`'s, so browser-check.cjs can start clean.
      persistState: { path: path.resolve(import.meta.dirname, ".wrangler/state") }
    }),
    tailwindcss()
  ],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  }
});
