import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ExposureMaterial,
  GelBundle,
  LadderMaterial,
  OrientationMaterial,
  RawImageMaterial,
} from '../shared/types';
import { openDatabase, type DB } from './db';
import { ProjectStore } from './store';
import { blobUri, computeInputDigest, imageId } from './identity';
import { sha256Hex } from './digest';
import {
  DEFAULT_LADDER_BP,
  FRONT_Y,
  GEL_H,
  GEL_W,
  WELL_Y,
  generateGel,
  rotatedPng,
  tForBp,
  type GelSpec,
} from './gelgen';
import { runAutoAnalysis } from './appService';
import { analyzeGel } from './analyze';
import { exportProject } from './transfer';
import { parseQuantity } from '../shared/units';
import { revisedBandParams } from './params';

export const CASE_PACK_VERSION = 'gel-lane-ruler/casepack/1.0.0';
export const CASE_PROJECT_ID = 'case-gel-0001';
export const CASE_NAME = '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台';

const T0 = '2026-09-19T00:33:12.000Z';
const clockIso = (clock: number) => {
  const t = new Date(T0);
  t.setUTCSeconds(t.getUTCSeconds() + clock);
  return t.toISOString();
};

function ladderMaterial(overrides?: Partial<Record<number, string>>): LadderMaterial {
  return {
    kind: 'ladder',
    ladderId: 'ladder-hi-lo-1kb',
    role: 'sizeDNA',
    rawText: DEFAULT_LADDER_BP.join(', ') + ' bp',
    entries: DEFAULT_LADDER_BP.map((bp, i) => ({
      entryId: `lm-${i + 1}`,
      ordinal: i,
      nominal: parseQuantity(overrides?.[i] ?? `${bp} bp`),
    })),
  };
}

const EXPOSURE: ExposureMaterial = {
  kind: 'exposure',
  duration: parseQuantity('400 ms'),
  gain: parseQuantity('1.2 ev'),
  fullScale: 255,
  saturationFraction: 0.98,
  rawText: '400ms, gain 1.2ev, 8bit',
};

const ORIENTATION_0: OrientationMaterial = {
  kind: 'orientation',
  declaredBy: 'operator',
  upDegrees: 0,
  confidence: 1,
  rawText: 'up=0°',
};

function baselineSpec(): GelSpec {
  const bands: GelSpec['bands'] = [];
  for (let i = 0; i < DEFAULT_LADDER_BP.length; i++) {
    bands.push({ laneIndex: 0, bp: DEFAULT_LADDER_BP[i], amp: 170 });
  }
  // 样品泳道：规则、可校准的条带
  const samples: Record<number, number[]> = {
    1: [4000, 1800, 900],
    2: [6000, 2500, 650],
    3: [3500, 1200],
    4: [8000, 2200, 450],
    5: [5000, 1000],
  };
  for (const [lane, bps] of Object.entries(samples)) {
    for (const bp of bps) bands.push({ laneIndex: Number(lane), bp, amp: 150 });
  }
  return { curved: false, bands };
}

export interface CaseBuildResult {
  bundle: GelBundle;
  dir: string;
  manifest: Record<string, unknown>;
}

function ingestImage(
  store: ProjectStore,
  branch: string,
  png: Buffer,
  width: number,
  height: number,
  orientation: OrientationMaterial,
  exposure: ExposureMaterial,
  ladder: LadderMaterial,
  clock: { v: number },
  opts?: { supersedeImage?: boolean; supersedeOrientation?: boolean }
): number {
  const sha = sha256Hex(png);
  const id = imageId(sha, width, height, orientation.upDegrees);
  const uri = blobUri(sha);
  store.putBlob(uri, sha, 'image/png', png);
  const image: RawImageMaterial = {
    kind: 'rawImage',
    imageId: id,
    width,
    height,
    channels: 1,
    bitDepth: 8,
    sha256: sha,
    blobUri: uri,
    byteLength: png.length,
  };
  if (opts?.supersedeImage) {
    store.addMaterial(
      branch,
      image,
      {
        logicalClock: ++clock.v,
        wallTimeUtcIso: clockIso(clock.v),
        supersede: { subjectId: 'image', reason: '只改动一个直接来源：旋转后的图像新版本' },
      }
    );
    store.addMaterial(branch, orientation, {
      logicalClock: ++clock.v,
      wallTimeUtcIso: clockIso(clock.v),
      supersede: { subjectId: 'orientation', reason: '旋转图像后拍摄方向同步为 90°' },
    });
  } else {
    store.addMaterial(branch, image, { logicalClock: ++clock.v, wallTimeUtcIso: clockIso(clock.v) });
    store.addMaterial(branch, orientation, { logicalClock: ++clock.v, wallTimeUtcIso: clockIso(clock.v) });
    store.addMaterial(branch, exposure, { logicalClock: ++clock.v, wallTimeUtcIso: clockIso(clock.v) });
    store.addMaterial(branch, ladder, { logicalClock: ++clock.v, wallTimeUtcIso: clockIso(clock.v) });
  }
  return clock.v;
}

interface ScenarioContext {
  db: DB;
  clock: { v: number };
  baselinePng: Buffer;
  baselineSpec: GelSpec;
  manifestScenarios: Record<string, unknown>[];
}

function analyzeBranch(db: DB, clock: { v: number }, branch: string, options?: {
  paramOverrides?: Record<string, number | string>;
  explicit?: { bandIndex: number; entryId: string }[];
  budgetPixels?: number;
}) {
  const r = runAutoAnalysis(db, CASE_PROJECT_ID, {
    branch,
    paramOverrides: options?.paramOverrides,
    explicitLadderAssignments: options?.explicit,
    budgetPixels: options?.budgetPixels,
    wallTimeUtcIso: clockIso(clock.v + 1),
    logicalClock: clock.v + 1,
  });
  clock.v = r.store.maxClock();
  return r;
}

function forkFromBaseline(store: ProjectStore, clock: { v: number }, branch: string, title: string) {
  store.createBranch(branch, 'main', { logicalClock: ++clock.v, wallTimeUtcIso: clockIso(clock.v) });
  return title;
}

export function rebuildOnBranch(
  ctx: ScenarioContext,
  branch: string,
  spec: GelSpec | null,
  transform?: { rotate: 90 | 180 | 270 },
  ladderOverride?: ReturnType<typeof ladderMaterial>
) {
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  const clock = { v: ctx.clock.v };
  if (spec) {
    const g = generateGel(spec);
    let png = g.png;
    let width = GEL_W;
    let height = GEL_H;
    let orientation: OrientationMaterial = ORIENTATION_0;
    if (transform) {
      const r = rotatedPng(g.image, transform.rotate);
      png = r.png;
      width = r.image.width;
      height = r.image.height;
      orientation = { ...ORIENTATION_0, upDegrees: transform.rotate, rawText: `up=${transform.rotate}°` };
    }
    ingestImage(store, branch, png, width, height, orientation, EXPOSURE, ladderOverride ?? ladderMaterial(), clock, {
      supersedeImage: true,
    });
  } else if (ladderOverride) {
    store.addMaterial(branch, ladderOverride, {
      logicalClock: ++clock.v,
      wallTimeUtcIso: clockIso(clock.v),
      supersede: { subjectId: ladderOverride.ladderId, reason: '只改动一个直接来源：ladder 标称值' },
    });
  }
  ctx.clock.v = clock.v;
  return analyzeBranch(ctx.db, ctx.clock, branch);
}

export function buildCasePack(outputDir: string): CaseBuildResult {
  mkdirSync(outputDir, { recursive: true });
  const dbPath = join(outputDir, 'case-build.sqlite');
  rmSync(dbPath, { force: true });
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  const db = openDatabase(dbPath);
  const clock = { v: 1 };
  ProjectStore.create(db, CASE_PROJECT_ID, CASE_NAME, {
    wallTimeUtcIso: clockIso(clock.v),
    logicalClock: clock.v,
    casePackVersion: CASE_PACK_VERSION,
  });
  const store = new ProjectStore(db, CASE_PROJECT_ID);

  // ---- 基线：原图 + 方向 + 曝光 + ladder，均像素级来源 ----
  const baseline = generateGel(baselineSpec());
  ingestImage(store, 'main', baseline.png, GEL_W, GEL_H, ORIENTATION_0, EXPOSURE, ladderMaterial(), clock);
  const baselineRun = analyzeBranch(db, clock, 'main');

  // 基线叙事：审阅者接受一个自动候选，比较自动候选与人工修订
  const firstCandidate = baselineRun.candidates.find((c) => c.status === 'candidate');
  if (firstCandidate) {
    store.recordDecision('main', 'acceptMwCandidate', firstCandidate.candidateId, {
      note: '基线：接受自动分子量候选',
      logicalClock: ++clock.v,
      wallTimeUtcIso: clockIso(clock.v),
    });
  }

  const manifestScenarios: Record<string, unknown>[] = [
    { scenarioId: 'baseline', branch: 'main', title: '基线：全部直接来源像素级保留，自动候选与人工接受' },
  ];
  const ctx: ScenarioContext = { db, clock, baselinePng: baseline.png, baselineSpec: baselineSpec(), manifestScenarios };

  buildRotation(ctx);
  buildSmile(ctx);
  buildMissingBand(ctx);
  buildSaturation(ctx);
  buildOverlap(ctx);
  buildNonMonotonic(ctx);
  buildLocalFailure(ctx);
  buildParamRevision(ctx);
  buildConflictingDecisions(ctx);

  const bundle = exportProject(db, CASE_PROJECT_ID, clockIso(clock.v));
  bundle.casePack = {
    casePackVersion: CASE_PACK_VERSION,
    manifestSha256: '',
    scenarios: manifestScenarios.map((m) => ({
      scenarioId: m.scenarioId as string,
      branch: m.branch as string,
      title: m.title as string,
    })),
  };

  const bundlePath = join(outputDir, 'bundles', 'gel-case-pack.bundle.json');
  mkdirSync(join(outputDir, 'bundles'), { recursive: true });
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const manifest = {
    casePackVersion: CASE_PACK_VERSION,
    projectId: CASE_PROJECT_ID,
    name: CASE_NAME,
    generatedLogicalClock: clock.v,
    coordinateBasis: { origin: 'top-left', units: 'px', wellY: WELL_Y, frontY: FRONT_Y, width: GEL_W, height: GEL_H },
    ladder: { id: 'ladder-hi-lo-1kb', role: 'sizeDNA', nominalBp: DEFAULT_LADDER_BP },
    scenarios: manifestScenarios,
    bundle: { path: 'bundles/gel-case-pack.bundle.json', sha256: sha256Hex(JSON.stringify(bundle)) },
  };
  bundle.casePack.manifestSha256 = sha256Hex(JSON.stringify(manifest));
  writeFileSync(bundlePath, JSON.stringify(bundle));
  manifest.bundle.sha256 = sha256Hex(JSON.stringify(bundle));
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(outputDir, 'README.md'),
    `# 胶道标尺 · 离线领域案例包\n\n版本：${CASE_PACK_VERSION}\n\n直接打开 http://127.0.0.1:5342 即载入本案例包（无需账号/云端）。\n`
  );
  return { bundle, dir: resolve(outputDir), manifest };
}

export {
  buildRotation,
  buildSmile,
  buildMissingBand,
  buildSaturation,
  buildOverlap,
  buildNonMonotonic,
  buildLocalFailure,
  buildParamRevision,
  buildConflictingDecisions,
} from './casepackScenarios';
