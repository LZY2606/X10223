import { defineConfig } from "vite";
import { apiPlugin } from "./src/server/api-plugin";

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: "127.0.0.1" },
});
