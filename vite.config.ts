import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { gelApiPlugin } from "./src/server/plugin";

export default defineConfig({
  plugins: [react(), gelApiPlugin()],
  server: { strictPort: true },
  test: { include: ["tests/**/*.test.ts"] },
});
