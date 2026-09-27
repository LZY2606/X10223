import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createApiMiddleware, getDefaultDbPath } from "./src/server/api";

// 同一个 Node 进程内直接承载业务规则：Vite dev server 挂载 API 中间件，
// 使“服务端/存储层可被直接调用”，而不是把规则藏在浏览器里。
export default defineConfig({
  plugins: [
    react(),
    {
      name: "gel-workbench-api",
      configureServer(server) {
        const store = createApiMiddleware(getDefaultDbPath());
        server.middlewares.use(store);
      },
      configurePreviewServer(server) {
        const store = createApiMiddleware(getDefaultDbPath());
        server.middlewares.use(store);
      }
    }
  ],
  server: { host: "127.0.0.1", port: 5342, strictPort: true }
});
