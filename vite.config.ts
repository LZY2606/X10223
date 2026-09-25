import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createApiRequestListener } from "./src/server/http.js";
import { Store } from "./src/server/store.js";
import { CasePackService } from "./src/server/casepack.js";
import { ensureBundledCasePackPath, defaultDatabasePath } from "./src/server/paths.js";

function gelApiPlugin(): Plugin {
  return {
    name: "gel-workbench-api",
    configureServer(server) {
      const api = createApiRequestListener(
        new Store(defaultDatabasePath()),
        new CasePackService(ensureBundledCasePackPath())
      );
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url === "/api" || url.startsWith("/api?")) {
          api(req, res);
        } else {
          next();
        }
      });
    }
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url))
    }
  },
  plugins: [gelApiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5342,
    strictPort: true
  },
  build: {
    target: "es2022",
    outDir: "dist"
  }
});
