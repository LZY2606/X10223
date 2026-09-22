import { contentId, sha256Text } from '../shared/ids.js';
import { diag } from '../shared/diagnostics.js';
import { runComputation } from './calibration.js';
import { buildCase } from './case-pack.js';
import { computeBandAlong } from './calibration.js';
import type {
  BandMaterial,
  ComputationResult,
  CounterexampleRecord,
  DomainEvent,
  EventPayload,
  MaterialBundle,
  ParameterSet,
  Point,
  ProjectState,
} from '../shared/types.js';
import type { GelRecipe } from './gel-render.js';

export const DEFAULT_PARAMS: Omit<ParameterSet, 'id' | 'version'> = {
  model: 'piecewise-log-linear',
  saturationThreshold: 0.98,
  overlapHalfWidthFactor: 1.0,
  bridgeMissingBands: true,
  monotonicTolerance: 0.02,
  forbidExtrapolation: true,
};

function makeParams(version: number, overrides: Partial<ParameterSet> = {}): ParameterSet {
  const body = { ...DEFAULT_PARAMS, ...overrides, version };
  return { ...body, id: contentId('params', body) } as ParameterSet;
}

export function materialsDigest(bundle: MaterialBundle): string {
  return sha256Text(
    JSON.stringify({
      img: bundle.image.sha256,
      orient: bundle.image.orientation,
      exposure: bundle.image.exposure,
      nominals: bundle.ladder.nominals.map((n) => ({ id: n.id, raw: n.nominal.rawText, missing: !!n.missing })),
      lanes: bundle.lanes.map((l) => ({ id: l.id, l: l.leftBoundary, r: l.rightBoundary, c: l.centerline })),
      bands: bundle.bands.map((b) => ({ id: b.id, c: b.center, sat: b.saturated, smear: b.smear, ovl: b.overlapsWith, nom: b.ladderNominalId, status: b.status })),
    }),
  );
}

function cloneBundle(b: MaterialBundle): MaterialBundle {
  return JSON.parse(JSON.stringify(b)) as MaterialBundle;
}

function refreshAlong(bundle: MaterialBundle): void {
  for (const band of bundle.bands) {
    const lane = bundle.lanes.find((l) => l.id === band.laneId);
    if (lane) band.alongPx = computeBandAlong(band, lane);
  }
}

export interface Decision {
  bandId: string;
  accepted: boolean;
  rangeOnly: boolean;
  atSeq: number;
  reason: string;
}

/**
 * 纯函数事件归约：给定事件序列重放为项目状态。
 * 每个 seq 的计算结果不可变；回到旧事件时恢复当时依赖版本与结论。
 */
export function replay(
  projectId: string,
  events: DomainEvent[],
  clock: () => string = () => new Date().toISOString(),
): ProjectState {
  let materials: MaterialBundle | null = null;
  const params: ParameterSet[] = [];
  let currentParamsId: string | null = null;
  const decisions: Decision[] = [];
  const resultsBySeq: Record<number, ComputationResult> = {};
  let slug = '';
  let name = '';
  let parentResultIds: string[] = [];

  const recompute = (seq: number, bundle: MaterialBundle | null): ComputationResult | null => {
    if (!bundle) return null;
    const ps = params.find((p) => p.id === currentParamsId) ?? params[params.length - 1];
    if (!ps) return null;
    refreshAlong(bundle);
    const result = runComputation(bundle, ps, parentResultIds, seq, materialsDigest(bundle), clock());
    // 人工决定不会覆盖计算结论：只在决定层标记采纳/否定；结果对象本身保持历史不变
    resultsBySeq[seq] = result;
    parentResultIds = [result.calibration.id];
    return result;
  };

  for (const ev of events) {
    const p = ev.payload;
    switch (p.type) {
      case 'PROJECT_CREATED':
        slug = p.slug;
        name = p.name;
        break;
      case 'MATERIALS_IMPORTED': {
        materials = cloneBundle(p.bundle);
        const v0 = makeParams(0);
        params.push(v0);
        currentParamsId = v0.id;
        recompute(ev.seq, materials);
        break;
      }
      case 'PARAMETERS_REVISED': {
        const prev = params.find((x) => x.id === currentParamsId);
        const next = makeParams((prev?.version ?? -1) + 1, prev ? { ...strip(prev), ...idUnsafe() } : {});
        // 用事件携带的目标参数（由 append 端构造，保证 reason 一致），这里仅记录
        break;
      }
      default:
        break;
    }
  }

  // 第二遍：参数/补丁/决定事件按序应用（保持简单线性实现）
  materials = null;
  params.length = 0;
  currentParamsId = null;
  decisions.length = 0;
  for (const k of Object.keys(resultsBySeq)) delete resultsBySeq[Number(k)];
  parentResultIds = [];

  for (const ev of events) applyEvent(ev);

  function applyEvent(ev: DomainEvent): void {
    const p = ev.payload;
    if (p.type === 'PROJECT_CREATED') {
      slug = p.slug;
      name = p.name;
    } else if (p.type === 'MATERIALS_IMPORTED') {
      materials = cloneBundle(p.bundle);
      const v0 = makeParams(0);
      params.push(v0);
      currentParamsId = v0.id;
      recompute(ev.seq, materials);
    } else if (p.type === 'PARAMETERS_REVISED') {
      // 参数体存放在事件之外不现实；此处通过 paramsId 内容哈希反查由 append 注入
      const injected = pendingParams.get(ev.id);
      if (injected) {
        params.push(injected);
        currentParamsId = injected.id;
      }
      recompute(ev.seq, materials);
    } else if (p.type === 'SOURCE_PATCHED') {
      if (materials) applySourcePatch(materials, p.objectKind, p.objectId, p.field, p.after);
      recompute(ev.seq, materials);
    } else if (p.type === 'AUTO_CANDIDATES_COMPUTED') {
      if (materials) resultsBySeq[ev.seq] = resultsBySeq[ev.seq] ?? resultsBySeq[ev.seq - 1];
    } else if (p.type === 'BAND_DECISION') {
      if (materials) {
        const band = materials.bands.find((b) => b.id === p.bandId);
        if (band) {
          if (p.decision === 'adjusted' && p.adjustment) band.center = { ...p.adjustment };
          band.status = p.decision === 'rejected' ? 'rejected' : 'confirmed';
        }
      }
      recompute(ev.seq, materials);
    } else if (p.type === 'MW_DECISION') {
      decisions.push({
        bandId: decisionsBandForInference(events, ev, p.inferenceId),
        accepted: p.decision === 'accepted',
        rangeOnly: p.decision === 'range-only',
        atSeq: ev.seq,
        reason: p.reason,
      });
      if (materials) resultsBySeq[ev.seq] = resultsBySeq[ev.seq] ?? recomputeCopy(ev.seq);
    } else if (p.type === 'CONFLICTING_DECISION') {
      decisions.push({
        bandId: decisionsBandForInference(events, ev, p.inferenceId),
        accepted: false,
        rangeOnly: false,
        atSeq: ev.seq,
        reason: p.reason,
      });
    } else if (p.type === 'COUNTEREXAMPLE_RUN') {
      // 档案事件不改变计算状态
    }
  }

  function recomputeCopy(seq: number): ComputationResult {
    const ps = params.find((x) => x.id === currentParamsId)!;
    const bundle = cloneBundle(materials!);
    refreshAlong(bundle);
    const result = runComputation(bundle, ps, parentResultIds, seq, materialsDigest(bundle), clock());
    parentResultIds = [result.calibration.id];
    return result;
  }

  return {
    projectId,
    slug,
    name,
    materials,
    params,
    currentParamsId,
    events,
    resultsBySeq,
    headSeq: events.reduce((m, e) => Math.max(m, e.seq), 0),
    decisions: decisions.map((d) => ({ ...d })),
  };
}

const pendingParams = new Map<string, ParameterSet>();

function strip(p: ParameterSet): Omit<ParameterSet, 'id' | 'version'> {
  const { id: _id, version: _v, ...rest } = p;
  return rest;
}
function idUnsafe(): Partial<ParameterSet> {
  return {};
}

function decisionsBandForInference(events: DomainEvent[], ev: DomainEvent, _inferenceId: string): string {
  // 回溯该 seq 的计算结果，由调用端在 append 时直接提供 band 关联；这里从事件 payload 兜底
  const mw = ev.payload as Extract<EventPayload, { type: 'MW_DECISION' }>;
  return (mw as unknown as { bandId?: string }).bandId ?? '';
}

export function applySourcePatch(bundle: MaterialBundle, kind: string, id: string, field: string, after: unknown): void {
  if (kind === 'band') {
    const band = bundle.bands.find((b) => b.id === id);
    if (!band) throw new Error(`patch target band ${id} not found`);
    if (field === 'center') (band as BandMaterial).center = after as Point;
    else (band as unknown as Record<string, unknown>)[field] = after;
  } else if (kind === 'ladderNominal') {
    const nom = bundle.ladder.nominals.find((n) => n.id === id);
    if (nom) (nom as unknown as Record<string, unknown>)[field] = after;
  } else if (kind === 'imageOrientation') {
    // 旋转图像是直接来源改动：方向与所有几何一起由导入包重建；引擎层仅标记
    (bundle.image.orientation as unknown as Record<string, unknown>)[field] = after;
  } else {
    throw new Error(`unsupported source patch kind ${kind}`);
  }
}

export { makeParams, pendingParams, refreshAlong };
