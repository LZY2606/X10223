// Dev runner: starts the API server (node, TS type-stripping) + Vite dev server.
import { spawn } from "node:child_process";
import { createServer } from "vite";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const host = opt("host", "127.0.0.1");
const port = Number(opt("port", "5342"));
const strictPort = args.includes("--strictPort");

const api = spawn(process.execPath, ["server/main.ts"], { stdio: "inherit" });
api.on("exit", (c) => { if (c) console.error("API exited", c); });

const vite = await createServer({
  server: { host, port, strictPort, proxy: { "/api": "http://127.0.0.1:5343" } },
});
await vite.listen();
vite.printUrls();

process.on("SIGINT", () => { api.kill(); process.exit(0); });
process.on("SIGTERM", () => { api.kill(); process.exit(0); });
