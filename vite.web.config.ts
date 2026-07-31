import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_"],
  base: "/app/",
  build: {
    outDir: "server/src/public/app",
    emptyOutDir: true,
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: "index.web.html",
    },
  },
  test: {
    environment: "jsdom",
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 1,
      },
    },
    fileParallelism: false,
  },
});
