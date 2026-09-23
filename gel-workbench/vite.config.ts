import { defineConfig } from "vite";

// Dev server is provided by src/server/main.ts (API + Vite middleware).
// `vite build` produces the static client; tests use vitest directly.
export default defineConfig({
  root: "src/client",
  build: { outDir: "../../dist", emptyOutDir: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
