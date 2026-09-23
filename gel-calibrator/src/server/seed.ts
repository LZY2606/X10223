// Builds the bundled offline case pack deterministically into a Store.
import { Store } from './store.js';
import {
  H, LANE_X, NOMINALS, SCENARIOS, W, laneCenterline, renderScenario,
} from '../core/scenarios.js';
import { rotate90Base64 } from '../core/render-gel.js';
import { projectToPolyline } from '../core/geometry.js';
import { BandCenterMaterial, GelImageMaterial, LadderMaterial, LaneBoundaryMaterial } from '../core/types.js';

function bandCenterOnCurve(
  laneIndex: number, y: number, smiles: number[], step = 6,
): { x: number; y: number } {
  const poly = laneCenterline({
    width: W, height: H, laneCenters: LANE_X, laneHalfWidth: 14, bands: [],
    laneSmileAmplitude: smiles,
  }, laneIndex, step);
  return projectToPolyline(poly, { x: LANE_X[laneIndex]!, y }).nearest;
}

export interface SeedSummary {
  narrativeId: string;
  projects: Array<{ id: string; kind: string; name: string }>;
}

export function seedStore(store: Store): SeedSummary {
  const projects: SeedSummary['projects'] = [];

  // ---- counterexample archive: one project per boundary condition ----------
  for (const def of SCENARIOS) {
    const pid = store.createProject(def.title, def.id);
    let img = renderScenario(def);
    let width = img.width, height = img.height, orientation = def.orientation;
    if (orientation === 90) {
      const r = rotate90Base64(img.base64, 1);
      img = { base64: r.base64, width: r.width, height: r.height };
      width = r.width; height = r.height;
    }
    registerImage(store, pid, img.base64, width, height, orientation, def.exposure.raw);
    registerGelGeometry(store, pid, def);
    runCompute(store, pid);
    projects.push({ id: pid, kind: def.id, name: def.title });
  }

  // ---- end-to-end narrative project on the baseline gel --------------------
  const base = SCENARIOS[0]!;
  const nid = store.createProject('胶道标尺工作台：自动候选 vs 人工修订（完整叙事）', 'narrative');
  const img = renderScenario(base);
  registerImage(store, nid, img.base64, img.width, img.height, 0, '120 ms');
  registerGelGeometry(store, nid, base);
  store.apply(nid, 'main', { kind: 'compute' });
  // accept one auto candidate, reject another (human revision)
  const st0 = store.stateAt(nid, 'main');
  const first = st0.inferences[0]!;
  const second = st0.inferences[1]!;
  if (!first || !second) {
    console.error('SEED DIAG baseline inferences:', st0.inferences.length, JSON.stringify(st0.diagnostics));
    projects.unshift({ id: nid, kind: 'narrative', name: '完整叙事项目' });
    return { narrativeId: nid, projects };
  }
  store.apply(nid, 'main', { kind: 'decide', targetValueId: first.id, action: 'accept', note: '自动候选与人工判读一致', actor: 'reviewer' });
  store.apply(nid, 'main', { kind: 'decide', targetValueId: second.id, action: 'reject', note: '自动候选位于拖尾边缘，人工否定', actor: 'reviewer' });

  // branch A: parameter revision (calib/1.1.0 narrows bridge gap)
  store.apply(nid, 'main', { kind: 'fork', newBranch: 'params-rev', fromEvent: st0.headEvent ?? undefined });
  store.apply(nid, 'params-rev', {
    kind: 'activateParams',
    params: {
      version: 'calib/1.1.0', model: 'log-linear-piecewise',
      saturationThreshold: 0.9, minLadderPoints: 3, maxBridgedGap: 1, evalBudget: 10000,
    },
  });
  store.apply(nid, 'params-rev', { kind: 'compute' });

  // branch B: single direct-source change (move one sample band) -> local dep only.
  // Samples live on lane index 1 => laneId L2.
  const oldBand = makeBandMaterial('L2', 'S1', 1, 110);
  const newBand = makeBandMaterial('L2', 'S1', 1, 124);
  store.apply(nid, 'main', { kind: 'fork', newBranch: 'source-edit' });
  store.apply(nid, 'source-edit', {
    kind: 'supersede', oldMaterialId: oldBand.id, newMaterial: newBand,
    reason: '仅改动一个直接来源：样本带 S1 中心由 y=110 修订为 y=124',
  });
  store.apply(nid, 'source-edit', { kind: 'compute' });

  // branch C: conflicting human decision on the same value
  store.apply(nid, 'main', { kind: 'fork', newBranch: 'conflict', fromEvent: undefined });
  store.apply(nid, 'conflict', {
    kind: 'decide', targetValueId: first.id, action: 'reject', note: '第二审阅者否定第一位的接受（互相冲突决定）', actor: 'reviewer-2',
  });

  // branch D: after revision, a band falls outside a narrowed ruler region
  const oob = makeBandMaterial('L2', 'S_OUT', 1, 330);
  store.apply(nid, 'params-rev', { kind: 'fork', newBranch: 'local-invalid' });
  store.apply(nid, 'local-invalid', { kind: 'register', material: stripId(oob) });
  store.apply(nid, 'local-invalid', { kind: 'compute' });

  projects.unshift({ id: nid, kind: 'narrative', name: '完整叙事项目' });
  return { narrativeId: nid, projects };
}

function stripId<T extends { id: string }>(m: T): Omit<T, 'id'> {
  const { id, ...rest } = m;
  return rest;
}

function registerImage(
  store: Store, pid: string, base64: string, width: number, height: number,
  orientation: 0 | 90 | 180 | 270, raw: string,
) {
  const m: Omit<GelImageMaterial, 'id'> = {
    kind: 'image', pngBase64: base64, widthPx: width, heightPx: height,
    sha256: 'derived-on-register', orientation,
    exposure: { value: parseInt(raw, 10) || 120, unit: 'ms', raw },
    label: `原始凝胶图（拍摄方向 ${orientation}°，曝光 ${raw}）`,
  };
  store.apply(pid, 'main', { kind: 'register', material: m });
}

function registerGelGeometry(store: Store, pid: string, def: (typeof SCENARIOS)[number]) {
  const smiles = def.smileAmplitudes;
  // lanes
  for (let laneIndex = 0; laneIndex < 3; laneIndex++) {
    const poly = laneCenterline(def.spec, laneIndex, 6);
    const lane: Omit<LaneBoundaryMaterial, 'id'> = {
      kind: 'lane', laneId: `L${laneIndex + 1}`, centerlinePx: poly, halfWidthPx: def.spec.laneHalfWidth,
      label: laneIndex === 0 ? 'Ladder 泳道' : `样本泳道 ${laneIndex}`,
    };
    store.apply(pid, 'main', { kind: 'register', material: lane });
  }
  // ladder
  const nominalDefs = NOMINALS.map((v) => ({ value: v, unit: 'bp' as const, raw: `${v} bp` }));
  const ladder: Omit<LadderMaterial, 'id'> = {
    kind: 'ladder', laneId: 'L1', nominals: nominalDefs, missingIndexes: def.missingIndexes,
    label: '分子量 ladder 标称值（原始表示保留）',
  };
  store.apply(pid, 'main', { kind: 'register', material: ladder });

  // ladder band centers (skip missing / saturated ladder bands as marker-role)
  const ladderYs = [55, 95, 135, 180, 230, 285];
  ladderYs.forEach((yInit, i) => {
    let y = yInit;
    if (def.id === 'nonmonotonic' && (i === 2 || i === 3)) y = i === 2 ? 200 : 135;
    if (def.missingIndexes.includes(i)) return;             // source-level missing
    const sat = def.id === 'saturated' && i === 3;         // saturated point excluded
    if (sat) return;
    const c = bandCenterOnCurve(0, y, smiles);
    const mat = makeBandMaterial('L1', `ladder-${i}`, 0, y, 'ladder', c, false, undefined, undefined, i);
    store.apply(pid, 'main', { kind: 'register', material: stripId(mat) });
  });

  // sample band centers on every non-ladder lane (so smile can compare lane 2 vs 3)
  for (let laneIndex = 1; laneIndex < 3; laneIndex++) {
    const samples = def.spec.bands.filter((b) => b.laneIndex === laneIndex);
    samples.forEach((b, i) => {
      const c = bandCenterOnCurve(laneIndex, b.y, smiles);
      const mat = makeBandMaterial(
        `L${laneIndex + 1}`, `S${i + 1}`, laneIndex, b.y, 'sample', c,
        b.saturated, b.smear, b.overlapWith !== undefined ? 'g1' : undefined);
      store.apply(pid, 'main', { kind: 'register', material: stripId(mat) });
    });
  }
}

function makeBandMaterial(
  laneId: string, key: string, laneIndex: number, y: number,
  role: 'ladder' | 'sample' = 'sample',
  center?: { x: number; y: number },
  saturated?: boolean, smeared?: boolean, overlapGroup?: string,
  ladderIndex?: number,
): BandCenterMaterial {
  const c = center ?? { x: LANE_X[laneIndex]!, y };
  const base = {
    kind: 'band' as const, laneId, bandKey: key, centerPx: c, role,
    ladderIndex,
    label: `${laneId} 条带中心 ${key} @ px(${c.x},${c.y})`,
  };
  const id = require_id(base);
  return { ...base, id, saturated, smeared, overlapGroup };
}
import { idForMaterial } from '../core/project.js';
function require_id(m: Omit<BandCenterMaterial, 'id'>): string { return idForMaterial(m); }

function runCompute(store: Store, pid: string) {
  store.apply(pid, 'main', { kind: 'compute' });
}
