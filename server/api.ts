import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { GelApp, appView } from "./app.ts";

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function createApi(app: GelApp, port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/state") return json(res, 200, app.state());
      if (req.method === "GET" && path === "/api/view") return json(res, 200, appView(app));
      if (req.method === "POST" && path === "/api/reset") {
        app.store.clearAll();
        const r = app.seed(Number(url.searchParams.get("budget") ?? 10000));
        return json(res, r.ok ? 200 : 422, r);
      }
      if (req.method === "POST" && path === "/api/compute") {
        const r = app.compute(Number(url.searchParams.get("budget") ?? 10000));
        return json(res, r.ok ? 200 : 422, r);
      }
      if (req.method === "POST" && path === "/api/decision") {
        const b = JSON.parse(await body(req));
        const ev = app.decide(b.kind, b.targetIds ?? [], b.note ?? "", b.branchId ?? "main");
        return json(res, 200, ev);
      }
      if (req.method === "POST" && path === "/api/source-change") {
        const b = JSON.parse(await body(req));
        const r = app.sourceChange(b.materialId, b.payload);
        return json(res, r.ok ? 200 : 422, r);
      }
      if (req.method === "GET" && path === "/api/export") return json(res, 200, app.export());
      if (req.method === "POST" && path === "/api/import") {
        const r = app.import(await body(req));
        return json(res, r.ok ? 200 : 422, r);
      }
      if (req.method === "GET" && path.startsWith("/api/replay/")) {
        return json(res, 200, app.replay(Number(path.split("/").pop())));
      }
      if (req.method === "GET" && path === "/api/image") {
        const p = app.imagePath();
        if (!p) return json(res, 404, { error: "no image" });
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(readFileSync(p));
      }
      return json(res, 404, { error: `no route ${path}` });
    } catch (e) {
      return json(res, 500, { error: String(e) });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
