import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BandMaterial,
  BranchInfo,
  ExposureMaterial,
  GelEvent,
  ImageMaterial,
  LadderNominalEntry,
  LadderNominalMaterial,
  LaneMaterial,
  Material,
  OrientationMaterial,
  ParamSet,
  PixelPoint
} from '../domain/types';
import { sha256Hex, stableId } from '../domain/hash';
import { makeEvent } from '../domain/replay';
import { decodePng } from '../domain/png';
import { bendAmount } from '../domain/geometry';
import { laneProfile } from '../domain/image-analysis';
import { analyze, type EngineContext } from '../domain/engine';
import { replay } from '../domain/state';
import { buildScenario, resultSignature, stableOrdering, type CounterexampleArchive } from '../domain/counterexample';
import type { Store } from './store';
import type { RotatedGelCase } from './case-types';

const PROJECT_ID = 'demo-gel-project';
const MAIN_BRANCH = 'br_main';

export function loadCasePack(rootDir: string): RotatedGelCase {
  const dir = join(rootDir, 'cases', 'gel-calibration-workbench');
  const pack = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as RotatedGelCase;
  return pack;
}

export function ensureSeeded(store: Store, rootDir: string): { projectId: string; recovered: string[] } {
  if (store.getProject(PROJECT_ID)) return { projectId: PROJECT_ID, recovered: [] };
  const pack = loadCasePack(rootDir);
  seedProject(store, pack, rootDir);
  return { projectId: PROJECT_ID, recovered: [] };
}

interface BuiltGel {
  materials: Material[];
  param: ParamSet;
}

const now0 = 1_890_000_000_000;

export function seedProject(store: Store, pack: RotatedGelCase, rootDir: string): string {
  const dir = join(rootDir, 'cases', 'gel-calibration-workbench');
  const events: GelEvent[] = [];
  let seq = 0;
  const ts = (k: number) => now0 + k * 60_000;
  const push = (type: GelEvent['type'], payload: unknown, summary: string, branchId = MAIN_BRANCH, paramVersion: number | null = null, parent?: string | null, actor = 'reviewer.li') => {
    const parentEventId = parent !== undefined ? parent : events.filter((e) => e.branchId === branchId).at(-1)?.id ?? null;
    const ev = makeEvent({
      projectId: PROJECT_ID,
      branchId,
      seq: ++seq,
      parentEventId,
      type,
      timestamp: ts(seq),
      actor,
      paramVersion,
      payload,
      summary
    });
    events.push(ev);
    store.appendEvent(ev);
    return ev;
  };

  store.createProject(PROJECT_ID, pack.name, now0, pack.version);
  push('project.created', { projectId: PROJECT_ID, name: pack.name }, '创建项目：凝胶分子量校准审阅', MAIN_BRANCH, null, null, 'system');

  // ---- 阶段 1：导入“基线胶”全部不可变材料（像素级来源） ----
  const built = buildGelMaterials(store, dir, pack, 'main', 1);
  for (const material of built.materials) {
    store.putMaterial(material);
    push(
      material.origin === 'imported' ? 'material.imported' : 'material.imported',
      { material },
      `导入材料：${materialLabel(material)}`,
      MAIN_BRANCH,
      null,
      undefined,
      'importer'
    );
  }
  store.putParam(built.param);
  push('param.revised', { param: built.param }, `参数 v${built.param.version}：自动检测默认参数`, MAIN_BRANCH, built.param.version, undefined, 'auto-analyzer');

  // ---- 阶段 2：自动分析 ----
  const ctx = engineContext(store);
  let state = replay(PROJECT_ID, events).state;
  let analysis = analyze(state, MAIN_BRANCH, events.at(-1)!.id, ctx);
  for (const result of analysis.results) {
    store.putResult(result);
    push('result.computed', { resultId: result.id, kind: result.kind, status: result.status }, `自动计算：${result.kind} (${result.status})`, MAIN_BRANCH, built.param.version, undefined, 'auto-analyzer');
  }

  // ---- 阶段 3：参数修订（v2：开启微笑检测、收紧峰距） ----
  const paramV2: ParamSet = { ...built.param, id: stableId('par', [PROJECT_ID, 2]), version: 2, createdAt: ts(++seq), minPeakDistancePx: 12, smileTolerancePx: 6, note: '审阅修订：显式启用微笑弯曲容许量' };
  store.putParam(paramV2);
  push('param.revised', { param: paramV2 }, '参数 v2：smileTolerance=6px，minPeakDistance=12px', MAIN_BRANCH, 2);
  state = replay(PROJECT_ID, events).state;
  analysis = recompute(store, state, events, MAIN_BRANCH, paramV2.version, ctx, push);

  // ---- 阶段 4：人工接受两个推断、否定一个 ----
  const mwResults = analysis.results.filter((r) => r.kind === 'mwInference') as Extract<(typeof analysis.results)[number], { kind: 'mwInference' }>[];
  const accepted = mwResults.find((r) => r.candidates.some((c) => c.kind === 'point'));
  if (accepted) {
    const c = accepted.candidates[0];
    push('decision.accepted', { resultId: accepted.bandId, verdict: 'accepted', chosen: { kind: 'point', mass: Math.round(c.mass), unit: c.unit }, reason: '与预期扩增子一致' }, `接受 ${Math.round(c.mass)}${c.unit}（${accepted.bandId.slice(0, 18)}…）`, MAIN_BRANCH, 2);
  }
  const rejected = mwResults.find((r) => r !== accepted && r.candidates.length > 0);
  if (rejected) {
    push('decision.rejected', { resultId: rejected.bandId, verdict: 'rejected', chosen: null, reason: '怀疑是非特异扩增，需重跑' }, `否定条带推断（${rejected.bandId.slice(0, 18)}…）`, MAIN_BRANCH, 2);
  }
  recompute(store, replay(PROJECT_ID, events).state, events, MAIN_BRANCH, 2, ctx, push);

  // ---- 阶段 5：只影响局部依赖的源数据改动（移动一条 band 中心，修订新材料版本） ----
  const laneMaterials = built.materials.filter((m) => m.kind === 'lane') as LaneMaterial[];
  const bandMaterials = built.materials.filter((m) => m.kind === 'band') as BandMaterial[];
  const sampleLane = laneMaterials.find((l) => l.role === 'sample' && l.label === 'S1')!;
  const targetBand = bandMaterials.find((b) => b.laneId === sampleLane.id)!;
  const movedBand: BandMaterial = {
    ...targetBand,
    id: stableId('bnd', [PROJECT_ID, targetBand.id, 'moved-6px']),
    center: { x: targetBand.center.x, y: targetBand.center.y + 6, frame: 'original' },
    origin: 'human',
    supersedes: targetBand.id,
    note: '人工修订：中心下移 6px（只改这一个直接来源）'
  };
  store.putMaterial(movedBand);
  push('material.revised', { material: movedBand }, '局部源改动：S1 上带中心 +6px', MAIN_BRANCH, 2);
  recompute(store, replay(PROJECT_ID, events).state, events, MAIN_BRANCH, 2, ctx, push);

  // ---- 阶段 6：互相冲突的人工决定（接受后又有冲突标记，两者都保留） ----
  if (accepted) {
    const c = accepted.candidates[0];
    push(
      'decision.conflict',
      { resultId: accepted.bandId, verdict: 'rejected', chosen: { kind: 'interval', low: Math.round(c.mass * 0.9), high: Math.round(c.mass * 1.1), unit: c.unit }, reason: '第二审阅者认为峰形偏宽，只接受 ±10% 区间' },
      `冲突决定：第二审阅者不接受点值，改区间 [${Math.round(c.mass * 0.9)}, ${Math.round(c.mass * 1.1)}] ${c.unit}`,
      MAIN_BRANCH,
      2,
      undefined,
      'reviewer.wang'
    );
    recompute(store, replay(PROJECT_ID, events).state, events, MAIN_BRANCH, 2, ctx, push);
  }

  // ---- 分支二：微笑弯曲专项（curved 胶作为独立分支材料集，演示局部标尺有效区域） ----
  const forkPoint = events.find((e) => e.type === 'param.revised' && e.paramVersion === 2)!;
  const smileBranch: BranchInfo = {
    id: stableId('br', [PROJECT_ID, '微笑弯曲专项']),
    projectId: PROJECT_ID,
    name: '微笑弯曲专项',
    parentBranchId: MAIN_BRANCH,
    forkEventId: forkPoint.id,
    createdAt: ts(++seq)
  };
  store.putBranch(smileBranch);
  push('branch.created', { branch: smileBranch }, `创建分支：${smileBranch.name}`, smileBranch.id, 2, null, 'system');

  // ---- 反例档案：基线 + 七个“只改一个直接来源”的场景 ----
  const archive = buildArchive(store, dir, pack, ctx, events);
  store.putArchive(PROJECT_ID, archive);

  // 主分支与微笑分支登记
  const mainBranch: BranchInfo = { id: MAIN_BRANCH, projectId: PROJECT_ID, name: '主线审阅', parentBranchId: null, forkEventId: null, createdAt: now0 };
  store.putBranch(mainBranch);
  return PROJECT_ID;
}

function recompute(
  store: Store,
  state: ReturnType<typeof replay>['state'],
  events: GelEvent[],
  branchId: string,
  paramVersion: number,
  ctx: EngineContext,
  push: (type: GelEvent['type'], payload: unknown, summary: string, branch?: string, pv?: number | null, parent?: string | null, actor?: string) => GelEvent
): ReturnType<typeof analyze> {
  const basis = events.filter((e) => e.branchId === branchId).at(-1)!;
  const analysis = analyze(state, branchId, basis.id, ctx);
  for (const result of analysis.results) {
    store.putResult(result);
    push('result.computed', { resultId: result.id, kind: result.kind, status: result.status }, `重算：${result.kind} (${result.status})`, branchId, paramVersion);
  }
  return analysis;
}

export function engineContext(store: Store): EngineContext {
  return {
    getImageBytes: (sha) => store.getImage(sha)?.bytes ?? null,
    decodePng: (bytes) => decodePng(bytes)
  };
}

function materialLabel(m: Material): string {
  switch (m.kind) {
    case 'image':
      return `原始图像 ${m.id.slice(0, 14)}…`;
    case 'orientation':
      return `拍摄方向 rotation=${m.rotation90 * 90}° flipH=${m.flipH} flipV=${m.flipV}`;
    case 'exposure':
      return `曝光 ${m.exposureS ?? '?'}s @ gain ${m.gain ?? '?'}`;
    case 'ladderNominal':
      return `ladder 标称值《${m.name}》`;
    case 'lane':
      return `lane ${m.label ?? m.laneIndex}`;
    case 'band':
      return `band@(${m.center.x.toFixed(0)},${m.center.y})`;
  }
}

function buildGelMaterials(store: Store, dir: string, pack: RotatedGelCase, gelKey: string, paramVersion: number): BuiltGel {
  const gel = pack.gels[gelKey];
  const pngBytes = new Uint8Array(readFileSync(join(dir, gel.file)));
  const decoded = decodePng(pngBytes);
  store.putImage(gel.sha256, pngBytes, decoded.width, decoded.height);

  const image: ImageMaterial = {
    id: stableId('img', [PROJECT_ID, gel.sha256]),
    projectId: PROJECT_ID,
    kind: 'image',
    origin: 'imported',
    createdAt: now0,
    supersedes: null,
    raw: { file: gel.file, width: gel.width, height: gel.height },
    sha256: gel.sha256,
    widthPx: gel.width,
    heightPx: gel.height,
    bitDepth: 8,
    channels: 1
  };

  const orientation: OrientationMaterial = {
    id: stableId('ori', [PROJECT_ID, gel.sha256, gel.orientation.rotation90]),
    projectId: PROJECT_ID,
    kind: 'orientation',
    origin: 'imported',
    createdAt: now0,
    supersedes: null,
    raw: gel.orientation,
    imageId: image.id,
    rotation90: gel.orientation.rotation90 as 0 | 1 | 2 | 3,
    flipH: gel.orientation.flipH,
    flipV: gel.orientation.flipV,
    rationale: 'imported-metadata: EXIF/拍摄记录'
  };

  const exposure: ExposureMaterial = {
    id: stableId('exp', [PROJECT_ID, gel.sha256, JSON.stringify(gel.exposure)]),
    projectId: PROJECT_ID,
    kind: 'exposure',
    origin: 'imported',
    createdAt: now0,
    supersedes: null,
    raw: gel.exposure,
    imageId: image.id,
    exposureS: gel.exposure.exposureS,
    gain: gel.exposure.gain,
    saturationLevel: gel.exposure.saturationLevel
  };

  const entries: LadderNominalEntry[] = pack.ladderTable.map((t) => ({
    row: t.row,
    token: t.token,
    mass: t.mass,
    unit: t.mass === null ? null : 'bp',
    diagnostic: t.mass === null ? `无法把 "${t.token}" 转换为 bp：保留原位于第 ${t.row} 行` : null
  }));
  const overrides = gel.nominalOverrides ?? {};
  for (const e of entries) {
    if (overrides[e.row] !== undefined) {
      e.mass = overrides[e.row];
      e.diagnostic = `人工/来源修订：标称值被改写为 ${overrides[e.row]}bp（原始 token=${e.token}）`;
    }
    if (gel.dropNominalRows.includes(e.row)) {
      e.diagnostic = `修订：第 ${e.row} 行标称锚点被删除（原始 token=${e.token}）`;
    }
  }
  const nominal: LadderNominalMaterial = {
    id: stableId('lad', [PROJECT_ID, gel.sha256, JSON.stringify(entries.map((e) => [e.row, e.mass]))]),
    projectId: PROJECT_ID,
    kind: 'ladderNominal',
    origin: 'imported',
    createdAt: now0,
    supersedes: null,
    raw: { tokens: pack.ladderTable.map((t) => t.token), overrides, dropRows: gel.dropNominalRows },
    imageId: image.id,
    name: 'DS-5k Demo Ladder',
    unit: 'bp',
    entries
  };

  const materials: Material[] = [image, orientation, exposure, nominal];
  const laneIds = new Map<number, string>();
  for (const lg of gel.lanes) {
    const center = lg.center.map((p) => ({ x: p.x, y: p.y, frame: 'original' as const }));
    const widthPx = lg.width;
    const lane: LaneMaterial = {
      id: stableId('lan', [PROJECT_ID, gel.sha256, lg.laneIndex, bendKey(center)]),
      projectId: PROJECT_ID,
      kind: 'lane',
      origin: 'auto',
      createdAt: now0,
      supersedes: null,
      raw: { laneIndex: lg.laneIndex, label: lg.label, detectedWidth: widthPx, source: 'casepack-truth->auto-detect' },
      imageId: image.id,
      laneIndex: lg.laneIndex,
      label: lg.label,
      role: lg.role,
      center,
      leftEdge: center.map((p) => ({ x: p.x - widthPx / 2, y: p.y, frame: 'original' as const })),
      rightEdge: center.map((p) => ({ x: p.x + widthPx / 2, y: p.y, frame: 'original' as const })),
      widthPx
    };
    laneIds.set(lg.laneIndex, lane.id);
    materials.push(lane);
  }

  const droppedRows = new Set(gel.dropNominalRows);
  for (const bg of gel.bands) {
    const laneId = laneIds.get(bg.laneIndex)!;
    const lane = materials.find((m) => m.id === laneId) as LaneMaterial;
    const profile = laneProfile(decoded.gray, decoded.width, decoded.height, lane.center, Math.round(lane.widthPx / 2) - 1, 2)
      .filter((p) => Math.abs(p.t - bg.y) < 60 || lane.role === 'ladder')
      .map((p) => ({ t: Math.round(p.t * 10) / 10, v: Math.round(p.v * 1000) / 1000 }));
    const flags: BandMaterial['flags'] = [];
    if (bg.saturated) flags.push('saturated');
    if (bg.smeared) flags.push('smeared');
    if (bg.overlap) flags.push('overlap', 'ambiguous');
    const isLadder = bg.laneIndex === 0;
    const entry = isLadder && bg.nominalRow !== null ? entries.find((e) => e.row === bg.nominalRow) : undefined;
    const nominalCandidates = entry && entry.mass !== null && !droppedRows.has(entry.row)
      ? [{ entryRow: entry.row, mass: entry.mass, unit: 'bp' as const }]
      : [];
    if (isLadder && bg.nominalRow !== null && (droppedRows.has(bg.nominalRow) || !entry || entry.mass === null)) flags.push('ladder-missing');
    const band: BandMaterial = {
      id: stableId('bnd', [PROJECT_ID, gel.sha256, laneId, bg.x, bg.y, bg.saturated, bg.overlap]),
      projectId: PROJECT_ID,
      kind: 'band',
      origin: 'auto',
      createdAt: now0,
      supersedes: null,
      raw: { x: bg.x, y: bg.y, detectedBy: 'casepack-truth->auto-detect', fwhmPx: bg.fwhm },
      imageId: image.id,
      laneId,
      center: { x: bg.x, y: bg.y, frame: 'original' } as PixelPoint,
      profile,
      peak: bg.saturated ? 1 : Math.round((0.55 + (bg.y % 7) * 0.03) * 1000) / 1000,
      saturated: bg.saturated,
      smeared: bg.smeared,
      fwhmPx: bg.fwhm,
      flags,
      nominalCandidates,
      note: null
    };
    materials.push(band);
  }

  const param: ParamSet = {
    id: stableId('par', [PROJECT_ID, paramVersion]),
    projectId: PROJECT_ID,
    version: paramVersion,
    createdAt: now0,
    saturationThreshold: 0.95,
    minPeakDistancePx: 16,
    smileTolerancePx: 12,
    interp: 'log-linear',
    extrapolate: false,
    note: '自动检测默认参数'
  };
  return { materials, param };
}

function bendKey(center: PixelPoint[]): string {
  return `${Math.round(bendAmount(center))}-${center.length}-${center[0].x}`;
}

function buildArchive(store: Store, dir: string, pack: RotatedGelCase, ctx: EngineContext, mainEvents: GelEvent[]): CounterexampleArchive {
  const baselineBuilt = buildGelMaterials(store, dir, pack, 'main', 2);
  const baselineState = replay(PROJECT_ID, mainEvents).state;
  const baselineResults = analyze(baselineState, MAIN_BRANCH, mainEvents.at(-1)!.id, ctx).results;
  const baseline = {
    sourceSummary: Object.fromEntries(baselineBuilt.materials.map((m) => [m.id, stableId('src', [m.kind, m.origin, m.raw])])),
    resultIds: baselineResults.map((r) => r.id),
    resultSignatures: Object.fromEntries(baselineResults.map((r) => [r.id, resultSignature(r)])),
    materials: baselineBuilt.materials,
    params: [baselineBuilt.param]
  };

  const adoptedIds = new Set(
    mainEvents
      .filter((e) => e.type === 'decision.accepted')
      .map((e) => (e.payload as { resultId: string }).resultId)
  );

  const scenarios: CounterexampleArchive['scenarios'] = [];
  pack.scenarios.forEach((sc, idx) => {
    const built = buildGelMaterials(store, dir, pack, sc.gel, 2);
    const state = replay(PROJECT_ID, []).state;
    for (const m of built.materials) {
      state.materials.set(m.id, m);
      if (m.kind === 'lane' || m.kind === 'band') {
        const list = m.kind === 'lane' ? state.lanes : state.bands;
        list.push(m);
      } else {
        state.latestByKind.set(`${m.kind}:${(m as { imageId?: string }).imageId ?? ''}`, m.id);
      }
    }
    state.params.push(built.param);
    const results = analyze(state, `sc_${sc.id}`, mainEvents.at(-1)!.id, ctx).results;
    const diag = results.flatMap((r) => ('diagnostics' in r ? r.diagnostics : []));
    const rules: Parameters<typeof buildScenario>[2]['rules'] = [];
    if (sc.gel === 'curved') {
      rules.push({
        ruleId: 'SMILE_SAME_HEIGHT_NOT_SAME_MW',
        message: '“微笑”弯曲使同一像素高度不等于同一分子量：必须沿泳道曲线取迁移弧长，局部标尺携带有效区域',
        diagnostics: diag.filter((d) => d.code === 'SMILE_BEND')
      });
    }
    if (['ladderMissing', 'localInvalid', 'nonmonotonic'].includes(sc.gel)) {
      rules.push({
        ruleId: 'LOCAL_RULER_NEEDS_VALID_REGION',
        message: '缺带/非单调使局部插值段失效：有效区域外不得给点值',
        diagnostics: diag.filter((d) => ['LADDER_MISSING_BAND', 'LADDER_NONMONOTONIC_SEGMENT', 'LOCAL_RULER_INVALIDATED', 'LADDER_NO_VALID_SEGMENT'].includes(d.code))
      });
    }
    if (sc.gel === 'saturation') {
      rules.push({
        ruleId: 'SATURATION_ONLY_CANDIDATE_OR_INTERVAL',
        message: '饱和条带峰顶不可信：只能标为候选或区间',
        diagnostics: diag.filter((d) => d.code === 'BAND_SATURATED')
      });
    }
    if (sc.gel === 'overlap') {
      rules.push({
        ruleId: 'OVERLAP_KEEP_ALL_LEGAL_CANDIDATES',
        message: '两条带重叠：保留全部合法候选，不得强行唯一化',
        diagnostics: diag.filter((d) => d.code === 'BAND_OVERLAP')
      });
    }
    if (sc.gel === 'rotated') {
      rules.push({
        ruleId: 'SMILE_SAME_HEIGHT_NOT_SAME_MW',
        message: '旋转图像后，lane/band 像素坐标经方向材料变换，弧长与基线一致（来源仍是原图）',
        diagnostics: diag
      });
    }
    const changedMaterialId = changedSourceOf(sc.gel, built.materials);
    const run = buildScenario(
      PROJECT_ID,
      baseline,
      {
        change: sc.id as Parameters<typeof buildScenario>[2]['change'],
        title: sc.title,
        changedSource: { materialKind: changedMaterialId?.kind ?? 'image', materialId: changedMaterialId?.id ?? null, note: sc.rule },
        expectedImpact: { include: sc.impact.include.length ? sc.impact.include : [sc.rule], exclude: [] },
        materials: built.materials,
        params: [built.param],
        results,
        adoptedResultIds: adoptedIds,
        rules
      },
      idx
    );
    scenarios.push(run);
    void stableOrdering;
  });

  return {
    id: stableId('arx', [PROJECT_ID, 'counterexample', pack.version]),
    projectId: PROJECT_ID,
    createdAt: now0,
    baseline,
    scenarios
  };
}

function changedSourceOf(gel: string, materials: Material[]): Material | null {
  if (gel === 'rotated') return materials.find((m) => m.kind === 'orientation') ?? null;
  if (gel === 'curved') return materials.find((m) => m.kind === 'lane' && (m as LaneMaterial).role === 'sample') ?? null;
  if (gel === 'ladderMissing') return materials.find((m) => m.kind === 'band' && (m as BandMaterial).flags.includes('ladder-missing')) ?? materials.find((m) => m.kind === 'ladderNominal')!;
  if (gel === 'saturation') return materials.find((m) => m.kind === 'band' && (m as BandMaterial).saturated) ?? null;
  if (gel === 'overlap') return materials.find((m) => m.kind === 'band' && (m as BandMaterial).flags.includes('overlap')) ?? null;
  if (gel === 'nonmonotonic') return materials.find((m) => m.kind === 'ladderNominal') ?? null;
  if (gel === 'localInvalid') return materials.find((m) => m.kind === 'ladderNominal') ?? null;
  return null;
}
