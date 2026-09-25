import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import type { CasePackService } from "./casepack.js";
import type { ProjectState } from "../shared/domain.js";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export function createApiRequestListener(store: Store, service: CasePackService): (req: IncomingMessage, res: ServerResponse) => void {
  const ensure = (projectId: string): void => {
    if (!store.projectExists(projectId)) throw new Error(`项目不存在：${projectId}`);
  };

  const handlers: Record<string, Handler> = {
    bootstrap: () => ({ projects: store.listProjects(), casePack: service.info() }),
    ensureSample: () => service.materialize(store),
    getState: (args) => {
      ensure(args.projectId as string);
      return serviceState(store, args);
    },
    runScenario: (args) => {
      ensure(args.projectId as string);
      return service.applyScenario(store, args.projectId as string, args.scenarioId as string);
    },
    replay: (args) => {
      const target = (args.projectId as string | undefined) ?? undefined;
      if (target && store.projectExists(target)) store.deleteProject(target);
      return service.replay(store);
    },
    decide: (args) => {
      ensure(args.projectId as string);
      store.appendEvent(args.projectId as string, (args.branch as string) ?? "main", {
        kind: "decision",
        at: new Date().toISOString(),
        verb: args.verb as "accept" | "reject" | "revise" | "supersede",
        targetKind: args.targetKind as "band-mw" | "lane" | "ladder-band" | "calibration",
        targetId: args.targetId as string,
        valueRaw: (args.valueRaw as string | null | undefined) ?? null,
        rationale: (args.rationale as string) ?? "",
        author: (args.author as string) ?? "reviewer",
        paramsVersion: store.getState(args.projectId as string).paramsVersion,
        derivedFromComputationId: store.getState(args.projectId as string).computation?.id ?? null
      });
      return serviceState(store, args);
    },
    reviseParams: (args) => {
      ensure(args.projectId as string);
      const before = store.getState(args.projectId as string, (args.branch as string) ?? "main");
      store.appendEvent(args.projectId as string, (args.branch as string) ?? "main", {
        kind: "param-revision",
        at: new Date().toISOString(),
        fromParamsVersion: before.paramsVersion,
        toParamsVersion: "",
        patch: args.patch as Record<string, unknown>,
        rationale: (args.rationale as string) ?? "",
        author: (args.author as string) ?? "reviewer"
      });
      const after = store.getState(args.projectId as string, (args.branch as string) ?? "main");
      return { state: after };
    },
    export: (args) => ({ bundle: store.exportProject(args.projectId as string) }),
    import: (args) => store.importProject(JSON.stringify(args.bundle)),
    deleteProject: (args) => {
      store.deleteProject(args.projectId as string);
      return { deleted: args.projectId };
    },
    evidence: (args) => ({ evidence: store.listEvidence(args.projectId as string) }),
    image: (args) => {
      ensure(args.projectId as string);
      const state = serviceState(store, args) as ProjectState;
      const frame = (args.frame as "raw" | "rotated" | undefined) ?? state.activeFrame;
      const image = Object.values(state.materials).find((m) => m.kind === "image" && m.frame === frame);
      if (!image || image.kind !== "image") throw new Error(`该帧没有图像：${frame}`);
      const blob = store.getBlob(image.blobId);
      if (!blob) throw new Error("图像 blob 缺失");
      return { __binary: true, data: blob.data, mediaType: blob.mediaType };
    }
  };

  return (req, res) => {
    const sendJson = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };
    const run = async (args: Record<string, unknown>): Promise<void> => {
      const action = args.action as string;
      const handler = handlers[action];
      if (!handler) {
        sendJson(404, { ok: false, error: `未知动作 ${action}` });
        return;
      }
      try {
        const data = await handler(args);
        if (data && typeof data === "object" && "__binary" in (data as Record<string, unknown>)) {
          const bin = data as { __binary: boolean; data: Buffer; mediaType: string };
          res.statusCode = 200;
          res.setHeader("content-type", bin.mediaType);
          res.end(bin.data);
          return;
        }
        sendJson(200, { ok: true, data });
      } catch (err) {
        sendJson(400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET") {
      const args: Record<string, unknown> = { action: url.searchParams.get("action") };
      for (const [k, v] of url.searchParams) if (k !== "action") args[k] = v;
      void run(args);
      return;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        try {
          const args = Buffer.concat(chunks).length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
          if (!args.action && url.searchParams.get("action")) args.action = url.searchParams.get("action");
          void run(args);
        } catch (err) {
          sendJson(400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    sendJson(405, { ok: false, error: "method not allowed" });
  };
}

function serviceState(store: Store, args: Record<string, unknown>): ProjectState {
  return store.getState(
    args.projectId as string,
    (args.branch as string) ?? "main",
    args.seq === undefined || args.seq === null || args.seq === "" ? undefined : Number(args.seq)
  );
}
