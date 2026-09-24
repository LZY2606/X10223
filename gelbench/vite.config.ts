import { defineConfig } from "vite";

export default defineConfig({
  root: "public",
  publicDir: "../generated",
  server: { host: "127.0.0.1", port: 5342, strictPort: true },
  build: { outDir: "../dist" },
});
