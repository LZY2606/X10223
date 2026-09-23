import { defineConfig } from "vite";
export default defineConfig({
  root: "client",
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5342, strictPort: true },
});
