import type { ExposureMaterial, LadderMaterial, OrientationMaterial, RawImageMaterial } from '../shared/types';
import { ProjectStore } from './store';
import { blobUri, imageId } from './identity';
import { sha256Hex } from './digest';
import { DEFAULT_LADDER_BP, generateGel, rotatedPng, tForBp, type GelSpec } from './gelgen';
import { parseQuantity } from '../shared/units';
import { revisedBandParams, DEFAULT_PARAMS, PARAM_VERSIONS } from './params';
import { analyzeBranch, rebuildOnBranch, type ScenarioContext } from './casepack';
import { CASE_PROJECT_ID } from './casepack';
import { GEL_H, GEL_W } from './gelgen';

const T0 = '2026-09-19T00:33:12.000Z';
const clockIso = (clock: number) => {
  const t = new Date(T0);
  t.setUTCSeconds(t.getUTCSeconds() + clock);
  return t.toISOString();
};

function ladder(overrides?: Partial<Record<number, string>>): LadderMaterial {
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

function scenario(ctx: ScenarioContext, scenarioId: string, branch: string, title: string) {
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  store.createBranch(branch, 'main', { logicalClock: ++ctx.clock.v, wallTimeUtcIso: clockIso(ctx.clock.v) });
  ctx.manifestScenarios.push({ scenarioId, branch, title });
}

/* 1. 旋转图像：唯一被改动的直接来源是图像像素（旋转 90°），方向材料同步更新 */
export function buildRotation(ctx: ScenarioContext) {
  scenario(ctx, 'rotation', 'scn-rotation', '旋转图像 90°：方向校正后 lane/band 身份稳定，分子量不变');
  rebuildOnBranch(ctx, 'scn-rotation', ctx.baselineSpec, { rotate: 90 });
}

/* 2. 微笑弯曲：同 y ≠ 同分子量；沿曲线弧长的局部标尺带有效区域 */
export function buildSmile(ctx: ScenarioContext) {
  scenario(ctx, 'smile', 'scn-smile', '“微笑”弯曲：同一高度不等于同一分子量，局部标尺声明 lane 与 t 有效区');
  const bands: GelSpec['bands'] = [];
  for (let i = 0; i < DEFAULT_LADDER_BP.length; i++) bands.push({ laneIndex: 0, bp: DEFAULT_LADDER_BP[i], amp: 165 });
  // 外侧弯曲 lane 与中央直 lane 放同样 1800bp 条带：像素 y 不同、分子量相同
  bands.push({ laneIndex: 1, bp: 1800, amp: 150 });
  bands.push({ laneIndex: 2, bp: 1800, amp: 150 });
  bands.push({ laneIndex: 5, bp: 1800, amp: 150 });
  bands.push({ laneIndex: 3, bp: 3200, amp: 150 });
  bands.push({ laneIndex: 4, bp: 650, amp: 150 });
  rebuildOnBranch(ctx, 'scn-smile', { curved: true, smileAmp: 30, bands });
}

/* 3. ladder 缺带：跳过缺失标称，相邻段仍有效但标注跨缺带 */
export function buildMissingBand(ctx: ScenarioContext) {
  scenario(ctx, 'missing-band', 'scn-missing-band', 'ladder 缺带（3000bp）：缺带诊断 + 跨缺带插值段有效区域');
  const bands: GelSpec['bands'] = [];
  DEFAULT_LADDER_BP.filter((bp) => bp !== 3000).forEach((bp) => bands.push({ laneIndex: 0, bp, amp: 165 }));
  bands.push({ laneIndex: 1, bp: 2600, amp: 150 });
  bands.push({ laneIndex: 2, bp: 1100, amp: 150 });
  rebuildOnBranch(ctx, 'scn-missing-band', { curved: false, bands });
}

/* 4. 饱和区：饱和条带只能是候选/区间，触顶像素被显式标注 */
export function buildSaturation(ctx: ScenarioContext) {
  scenario(ctx, 'saturation', 'scn-saturation', '饱和区：触顶条带只允许候选或区间，不给唯一接受值');
  const bands: GelSpec['bands'] = [];
  for (let i = 0; i < DEFAULT_LADDER_BP.length; i++) bands.push({ laneIndex: 0, bp: DEFAULT_LADDER_BP[i], amp: 165 });
  bands.push({ laneIndex: 1, bp: 2500, amp: 150 });
  bands.push({ laneIndex: 2, bp: 2500, amp: 260, saturate: true });
  bands.push({ laneIndex: 3, bp: 900, amp: 260, saturate: true });
  bands.push({ laneIndex: 4, bp: 4000, amp: 220, tail: true });
  rebuildOnBranch(ctx, 'scn-saturation', { curved: false, bands, gain: 1.15 });
}

/* 5. 两条带重叠：浅谷双峰都保留为候选/区间 */
export function buildOverlap(ctx: ScenarioContext) {
  scenario(ctx, 'overlap', 'scn-overlap', '两条带重叠：浅谷分解，无法唯一决定时保留全部合法候选');
  const bands: GelSpec['bands'] = [];
  for (let i = 0; i < DEFAULT_LADDER_BP.length; i++) bands.push({ laneIndex: 0, bp: DEFAULT_LADDER_BP[i], amp: 165 });
  // 900bp 与 ~760bp 在 t 上相距约 12px，合成浅谷
  bands.push({ laneIndex: 1, bp: 900, amp: 150 });
  bands.push({ laneIndex: 1, bp: 760, amp: 140 });
  bands.push({ laneIndex: 2, bp: 2400, amp: 150 });
  bands.push({ laneIndex: 2, bp: 2100, amp: 145 });
  rebuildOnBranch(ctx, 'scn-overlap', { curved: false, bands });
}

/* 6. 非单调标尺：标称 2000/3000 互换 -> 局部段斜率为正 -> 语义无解，不画假曲线 */
export function buildNonMonotonic(ctx: ScenarioContext) {
  scenario(ctx, 'non-monotonic', 'scn-non-monotonic', '非单调标尺：局部段物理方向反转，落在该段的条带判为语义无解');
  const bands: GelSpec['bands'] = [];
  for (let i = 0; i < DEFAULT_LADDER_BP.length; i++) bands.push({ laneIndex: 0, bp: DEFAULT_LADDER_BP[i], amp: 165 });
  bands.push({ laneIndex: 1, bp: 2500, amp: 150 });
  bands.push({ laneIndex: 2, bp: 800, amp: 150 });
  const g = generateGel({ curved: false, bands });
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  const clock = { v: ctx.clock.v };
  // 像素图像不变（这是标尺来源问题）；只替换 ladder 标称：2000bp(lm-5) 与 3000bp(lm-4) 互换
  const swapped = ladder({ 4: '2000 bp', 5: '3000 bp' });
  store.addMaterial(
    'scn-non-monotonic',
    swapped,
    {
      logicalClock: ++clock.v,
      wallTimeUtcIso: clockIso(clock.v),
      supersede: { subjectId: 'ladder-hi-lo-1kb', reason: '只改动一个直接来源：ladder 标称 2000/3000 互换，造成非单调' },
    }
  );
  ctx.clock.v = clock.v;
  // 分支需要先拥有图像材料才能分析：从 main 继承的 tip 已含基线全部材料
  analyzeBranch(ctx.db, ctx.clock, 'scn-non-monotonic');
}

/* 7. 修订后局部失效：人工修订一条 lane 曲线，仅该 lane 的候选失效，其余不动 */
export function buildLocalFailure(ctx: ScenarioContext) {
  scenario(ctx, 'local-failure', 'scn-local-failure', '修订后局部失效：改动单条 lane 曲线，仅其子树分子量候选失效并可重算');
  // 继承基线后，人工修订 lane-3 的一个控制点（拖拽造成弯曲）
  const run = analyzeBranch(ctx.db, ctx.clock, 'scn-local-failure');
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  const tip = store.tip('scn-local-failure');
  const target = tip.lanes['lane-3'];
  const dragged = target.center.controlPoints.map((p, idx) =>
    idx === 2 ? { ...p, x: p.x + 22 } : p
  );
  const revised: typeof target = {
    ...target,
    source: 'operator',
    center: { ...target.center, controlPoints: dragged },
  };
  store.addMaterial('scn-local-failure', revised, {
    logicalClock: ++ctx.clock.v,
    wallTimeUtcIso: clockIso(ctx.clock.v),
    supersede: { subjectId: 'lane-3', reason: '人工拖拽 lane-3 中部控制点（局部来源改动）' },
  });
  // 重新分析：lane-3 的候选带新输入摘要；lane-2/lane-4 的结论不重算、身份不变
  const rerun = analyzeBranch(ctx.db, ctx.clock, 'scn-local-failure');
  void run;
  void rerun;
  const rerunTip = store.tip('scn-local-failure');
  const lane3Candidates = Object.values(rerunTip.candidates).filter((c) => c.laneId === 'lane-3');
  store.append(
    'scn-local-failure',
    'derivationEmitted',
    {
      kind: 'invalidation',
      record: {
        candidateIds: lane3Candidates
          .filter((c) => c.inputDigest !== run.inputDigest)
          .map((c) => c.candidateId),
        reason: 'lane-3 曲线人工修订，旧输入摘要的候选局部失效',
      },
    },
    { logicalClock: ++ctx.clock.v, wallTimeUtcIso: clockIso(ctx.clock.v) }
  );
}

/* 8. 参数修订：bandDetection 1.0 -> 2.0，参数版本写入候选 */
export function buildParamRevision(ctx: ScenarioContext) {
  scenario(ctx, 'param-revision', 'scn-param-revision', '参数修订：bandDetection/2.0 只影响派生层，材料身份不变，历史绑定旧版本');
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  const revised = revisedBandParams(DEFAULT_PARAMS[PARAM_VERSIONS.bandDetection]);
  store.recordDecision('scn-param-revision', 'paramRevision', 'gel.bandDetection', {
    note: '峰间距 8px -> 11px，浅谷阈值 0.55 -> 0.62',
    paramSet: revised,
    logicalClock: ++ctx.clock.v,
    wallTimeUtcIso: clockIso(ctx.clock.v),
  });
  analyzeBranch(ctx.db, ctx.clock, 'scn-param-revision', {
    paramOverrides: { minPeakDistancePx: 11, overlapValleyRatio: 0.62 },
  });
}

/* 9. 互相冲突的人工决定：同一分子量先接受、再人工覆盖/否定，两个结果都保留 */
export function buildConflictingDecisions(ctx: ScenarioContext) {
  scenario(ctx, 'conflict', 'scn-conflict', '互相冲突的人工决定：接受与覆盖并存，状态标冲突而不是后者覆盖前者');
  const run = analyzeBranch(ctx.db, ctx.clock, 'scn-conflict');
  const store = new ProjectStore(ctx.db, CASE_PROJECT_ID);
  const target = run.candidates.find((c) => c.status === 'candidate') ?? run.candidates[0];
  store.recordDecision('scn-conflict', 'acceptMwCandidate', target.candidateId, {
    note: '审阅者 A：接受自动候选',
    logicalClock: ++ctx.clock.v,
    wallTimeUtcIso: clockIso(ctx.clock.v),
  });
  store.recordDecision('scn-conflict', 'overrideMw', target.candidateId, {
    note: '审阅者 B：依据外部 qPCR 对照人工修订分子量',
    value: parseQuantity('2050 bp'),
    logicalClock: ++ctx.clock.v,
    wallTimeUtcIso: clockIso(ctx.clock.v),
  });
}
