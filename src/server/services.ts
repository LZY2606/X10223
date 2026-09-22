import { Store } from '../storage/store';
import { openDatabase, recoverPendingWrites } from '../storage/db';
import { GelEngine } from '../domain/engine';
import { seedFromCasePack } from '../domain/seeder';
import { exportProject, importBundle, parseBundle, type ExportBundle } from '../domain/transfer';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface ServerState {
  store: Store;
  engine: GelEngine;
  dbPath: string;
  seedInfo: { baselineProjectId: string; scenarioProjectIds: Record<string, string> } | null;
}

let state: ServerState | null = null;

export function getState(): ServerState {
  if (state) return state;
  const dbPath = resolve(process.cwd(), 'data/gelbench.sqlite');
  const db = openDatabase(dbPath);
  recoverPendingWrites(db);
  const store = new Store(db);
  const engine = new GelEngine(store);
  let seedInfo: ServerState['seedInfo'] = null;
  if (store.listProjects().length === 0) {
    const seeded = seedFromCasePack(store);
    seedInfo = { baselineProjectId: seeded.baselineProjectId, scenarioProjectIds: seeded.scenarioProjectIds };
  }
  state = { store, engine, dbPath, seedInfo };
  return state;
}

export function resetStateForTests(dbPath = ':memory:', seed = true): ServerState {
  const db = openDatabase(dbPath);
  const store = new Store(db);
  const engine = new GelEngine(store);
  let seedInfo: ServerState['seedInfo'] = null;
  if (seed) {
    const seeded = seedFromCasePack(store);
    seedInfo = { baselineProjectId: seeded.baselineProjectId, scenarioProjectIds: seeded.scenarioProjectIds };
  }
  state = { store, engine, dbPath, seedInfo };
  return state;
}

export function projectView(projectId: string, atEventId?: string) {
  const { store } = getState();
  const project = store.getProject(projectId);
  if (!project) return undefined;
  const branches = store.listBranches(projectId);
  const events = store.listEvents(projectId);
  const viewEventId = atEventId ?? store.getHead(projectId, 'main').headEventId!;
  const materials = store.materialsAtEvent(projectId, viewEventId);
  const derived = store.listDerivedAt(projectId, viewEventId);
  const allDerived = store.listDerivedAll(projectId);
  const ancestry = store.ancestry(projectId, viewEventId).map((e) => e.id);
  return { project, branches, events, viewEventId, ancestry, materials, derived, allDerived };
}

export function projectImage(projectId: string, imageId: string): { bytes: Buffer; format: string } | undefined {
  const { store } = getState();
  const mats = store.listMaterialsCurrent(projectId).concat(
    // 历史图像版本（旋转情形的原图帧）
    rawAllMaterials(store, projectId)
  );
  const image = mats.find((m) => m.id === imageId && m.type === 'image');
  if (!image || image.type !== 'image') return undefined;
  return store.getBlob(image.blobSha256);
}

function rawAllMaterials(store: Store, projectId: string) {
  const db = (store as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => { body_json: string }[] } } }).db;
  return db.prepare(`SELECT body_json FROM materials WHERE project_id=?`).all(projectId).map((r) => JSON.parse(r.body_json));
}

export function doExport(projectId: string) {
  return exportProject(getState().store, projectId);
}

export function doImport(jsonText: string, bytesLen: number, simulateCrashAt?: number) {
  const parsed = parseBundle(jsonText, bytesLen);
  if (!parsed.ok) return parsed.outcome;
  return importBundle(getState().store, parsed.bundle, { simulateCrashAt });
}

export function bundleFromJson(jsonText: string): { ok: true; bundle: ExportBundle } | ReturnType<typeof parseBundle> {
  return parseBundle(jsonText, jsonText.length);
}

export function readCaseManifest() {
  const p = resolve(process.cwd(), 'cases/case-manifest.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return null;
}
