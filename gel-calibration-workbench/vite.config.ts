import { defineConfig } from "vite";

// Vite is used for the client build/serving and (via vitest) for tests.
export default defineConfig({
  root: "src/client",
  base: "/",
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5342,
    strictPort: true,
    middlewareMode: true,
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
