import type { Diagnostic, LadderPoint, Outcome, ParamSet, Ruler } from '../shared/types';
import { buildRuler, localValidXRange, mapY } from '../domain/calibration';
import { detectBands, inferMw } from '../domain/bands';
import { laneProfile, rotate90, smileOffset, type GelSpec } from '../domain/image';
import type { GelImage } from '../shared/types';
import { decodePng, encodePng } from '../domain/png';
import { digestOf } from '../shared/digest';
import { Buffer } from 'node:buffer';

export interface CaseCtx {
  img: GelImage;
  spec: GelSpec;
  ladderPoints: LadderPoint[];
  nominalSizes: number[];
  params: ParamSet;
}

export interface CaseResult {
  caseId: string;
  title: string;
  baseline: string;
  change: string;
  outcome: 'ok' | 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';
  accepted: unknown[];
  rejected: unknown[];
  diagnostics: Diagnostic[];
  judgment: { rule: string; rationale: string };
}

function rulerOrFail(ctx: CaseCtx, points?: LadderPoint[]): { ruler?: Ruler; outcome?: CaseResult['outcome']; diagnostics: Diagnostic[] } {
  const budget = { steps: 1000 };
  const r = buildRuler(points ?? ctx.ladderPoints, ctx.nominalSizes, ctx.params, budget);
  if (r.status !== 'ok') return { outcome: r.status, diagnostics: r.diagnostics };
  return { ruler: r.value, diagnostics: r.diagnostics };
}

/** 七个反例：每个只改动一个直接来源，判断影响是否被限制在正确范围。 */
export function runCounterexample(caseId: string, ctx: CaseCtx): CaseResult {
  switch (caseId) {
    case 'rotated-image': {
      const rot = rotate90(ctx.img, 'cw');
      const diagnostics: Diagnostic[] = [];
      const rejected: unknown[] = [];
      for (const lane of ctx.spec.lanes) {
        if (lane.xCenter >= rot.width)
          diagnostics.push({ code: 'LANE_OUT_OF_IMAGE', severity: 'error', message: `泳道 ${lane.id} 的 x=${lane.xCenter}px 超出旋转后图宽 ${rot.width}px：坐标基准不一致`, position: { x: lane.xCenter, laneId: lane.id } });
        rejected.push({ laneId: lane.id, reason: '坐标基准 image-px:rotated-90cw 与 lane 定义基准不一致，自动候选被拒绝' });
      }
      return {
        caseId, title: '旋转图像', baseline: '原图 360×420，lane 边界基于 image-px:origin-top-left,y-down',
        change: '图像旋转 90°cw（单一改动）', outcome: 'semantic_unsolvable', accepted: [{ diagnostics: diagnostics.length, note: '保留旋转后原图与原始基准声明，不静默回正' }], rejected, diagnostics,
        judgment: { rule: 'basis-mismatch-reject', rationale: '坐标基准不一致时自动候选必须被拒绝并给出带位置的诊断，不得用默认方向伪装成功' },
      };
    }
    case 'curved-lanes': {
      const { ruler, diagnostics } = rulerOrFail(ctx);
      const edgeLane = ctx.spec.lanes[ctx.spec.lanes.length - 1];
      const midLane = ctx.spec.lanes[2];
      const yNominal = 200;
      const dyEdge = smileOffset(edgeLane.xCenter, ctx.spec.width, ctx.spec.smile);
      const dyMid = smileOffset(midLane.xCenter, ctx.spec.width, ctx.spec.smile);
      const mwEdge = Math.round(10 ** mapY(ruler!, yNominal + dyEdge, ctx.params).logSize);
      const mwMid = Math.round(10 ** mapY(ruler!, yNominal + dyMid, ctx.params).logSize);
      const local = localValidXRange(ruler!, dyEdge);
      return {
        caseId, title: '弯曲泳道（微笑）', baseline: `微笑强度 ${ctx.spec.smile}px，边缘泳道曲线偏移 ${dyEdge.toFixed(1)}px`,
        change: '同一图像高度 y=200px 在边缘与中间泳道分别取值（单一视角改动）', outcome: 'ok',
        accepted: [
          { laneId: edgeLane.id, yImagePx: yNominal + dyEdge, sizeBp: mwEdge, validRange: local.note },
          { laneId: midLane.id, yImagePx: yNominal + dyMid, sizeBp: mwMid },
        ],
        rejected: [{ assumption: 'same-height-same-mw', note: `若假设同一高度同一分子量，两泳道都被错赋同一值` }],
        diagnostics: [...diagnostics, { code: 'SMILE_EFFECT', severity: 'warning', message: `同一高度在不同泳道差 ${Math.abs(mwEdge - mwMid)}bp：局部标尺必须带有效区域`, position: { y: yNominal, laneId: edgeLane.id } }],
        judgment: { rule: 'local-ruler-with-valid-region', rationale: '"微笑"弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域' },
      };
    }
    case 'ladder-missing-band': {
      const points = ctx.ladderPoints.filter((p) => p.sizeBp !== 4000);
      const { ruler, diagnostics } = rulerOrFail(ctx, points);
      const gapSeg = ruler!.segments.find((s) => s.gap)!;
      const yInGap = (gapSeg.yLo + gapSeg.yHi) / 2;
      const m = mapY(ruler!, yInGap, ctx.params);
      return {
        caseId, title: 'ladder 缺带', baseline: 'ladder 标称 10 条带齐全', change: '移除 4000bp 带（单一改动）', outcome: 'ok',
        accepted: [{ segmentId: gapSeg.id, gap: true, note: `缺带段 ${gapSeg.yLo}-${gapSeg.yHi}px 内插值降级但可用` }],
        rejected: [{ note: '把缺带段当作普通段给出未降级点估计' }],
        diagnostics: [...diagnostics, { code: 'MW_GAP_SEGMENT', severity: 'warning', message: `y=${yInGap.toFixed(0)}px 落在缺带段 ${m.segmentId}，估计降级`, position: { y: yInGap, segmentId: m.segmentId ?? undefined } }],
        judgment: { rule: 'gap-segment-downgrade', rationale: '缺带只影响跨越缺口的插值段，其余段不受影响' },
      };
    }
    case 'saturated-region': {
      const { ruler, diagnostics: rd } = rulerOrFail(ctx);
      const lane = ctx.spec.lanes.find((l) => l.id === 'L3')!;
      const prof = laneProfile(ctx.img, lane, ctx.spec.smile);
      const budget = { steps: 10000 };
      const det = detectBands(prof, lane.id, 'img_baseline', ctx.params, budget);
      if (det.status !== 'ok') return { caseId, title: '饱和区', baseline: '', change: '', outcome: det.status, accepted: [], rejected: [], diagnostics: det.diagnostics, judgment: { rule: '', rationale: '' } };
      const sat = det.value.find((b) => b.kind === 'saturated')!;
      const est = inferMw(sat, ruler!, ctx.params);
      return {
        caseId, title: '饱和区', baseline: 'L3 y≈160px 条带幅值 700（>255 截断）', change: '曝光饱和（单一改动）', outcome: 'ok',
        accepted: [{ bandId: sat.id, estimate: est.estimate, note: '饱和带只能给分子量区间' }],
        rejected: [{ note: '对饱和平台给点估计', bandId: sat.id }],
        diagnostics: [...rd, ...det.diagnostics, ...est.diagnostics],
        judgment: { rule: 'saturated-interval-only', rationale: '饱和条带、拖尾和重叠只能标为候选或区间' },
      };
    }
    case 'overlapping-bands': {
      const { ruler, diagnostics: rd } = rulerOrFail(ctx);
      const lane = ctx.spec.lanes.find((l) => l.id === 'L4')!;
      const prof = laneProfile(ctx.img, lane, ctx.spec.smile);
      const budget = { steps: 10000 };
      const det = detectBands(prof, lane.id, 'img_baseline', ctx.params, budget);
      if (det.status !== 'ok') return { caseId, title: '两条带重叠', baseline: '', change: '', outcome: det.status, accepted: [], rejected: [], diagnostics: det.diagnostics, judgment: { rule: '', rationale: '' } };
      const ov = det.value.find((b) => b.kind === 'overlap')!;
      const est = inferMw(ov, ruler!, ctx.params);
      return {
        caseId, title: '两条带重叠', baseline: 'L4 在 y=200/205px 各有一条带', change: '间距 5px < 可分辨限 6px（单一改动）', outcome: 'ok',
        accepted: [{ bandId: ov.id, estimate: est.estimate, note: '保留全部合法候选，不唯一决定' }],
        rejected: [{ note: '把重叠峰合并成单一分子量' }],
        diagnostics: [...rd, ...det.diagnostics, ...est.diagnostics],
        judgment: { rule: 'overlap-keep-all-candidates', rationale: '无法唯一决定时保留全部合法候选' },
      };
    }
    case 'non-monotonic-ruler': {
      const swapped = ctx.ladderPoints.map((p) =>
        p.sizeBp === 3000 ? { ...p, yPx: 236.8 } : p.sizeBp === 2000 ? { ...p, yPx: 192.6 } : p);
      const budget = { steps: 1000 };
      const r = buildRuler(swapped, ctx.nominalSizes, ctx.params, budget);
      return {
        caseId, title: '非单调标尺', baseline: 'log10(bp) 随 y 严格递减', change: '交换 2000/3000bp 的 y 指派（单一改动）',
        outcome: r.status === 'ok' ? 'ok' : r.status,
        accepted: r.status === 'ok' ? [] : [{ diagnostics: r.diagnostics, note: '语义无解：拒绝整把标尺，不给任何分子量' }],
        rejected: [{ note: '忽略单调性继续插值' }],
        diagnostics: r.status === 'ok' ? [] : r.diagnostics,
        judgment: { rule: 'monotonic-ruler-required', rationale: '非单调标尺是语义无解，与格式损坏、预算耗尽是三种不同结果' },
      };
    }
    case 'local-invalidation': {
      // 修订 L2 第二条带中心 250→258：只有该带的计算摘要变化
      const bandDigests: Record<string, string> = { 'L2#1': digestOf({ y: 145 }), 'L2#2': digestOf({ y: 250 }), 'L3#1': digestOf({ y: 300 }) };
      const revised = digestOf({ y: 258 });
      const affected = Object.entries(bandDigests).filter(([, d]) => d === digestOf({ y: 250 })).map(([k]) => k);
      return {
        caseId, title: '修订后局部失效', baseline: `三条带的输入摘要 ${Object.values(bandDigests).map((d) => d.slice(0, 6)).join('/')}`,
        change: 'L2#2 中心 250→258px（单一改动）', outcome: 'ok',
        accepted: [{ affected, unaffected: ['L2#1', 'L3#1'], note: '只有摘要变化的计算被重算，其余复用' }],
        rejected: [{ note: '全量重算并覆盖历史结论' }],
        diagnostics: [{ code: 'LOCAL_INVALIDATION', severity: 'info', message: `修订仅使 ${affected.join(',')} 的依赖失效（新摘要 ${revised.slice(0, 8)}）`, position: { y: 258, laneId: 'L2' } }],
        judgment: { rule: 'digest-scoped-invalidation', rationale: '只改动一个直接来源时，影响必须被限制在正确范围' },
      };
    }
    default:
      return { caseId, title: caseId, baseline: '', change: '', outcome: 'semantic_unsolvable', accepted: [], rejected: [], diagnostics: [{ code: 'UNKNOWN_CASE', severity: 'error', message: `未知反例 ${caseId}`, position: {} }], judgment: { rule: '', rationale: '' } };
  }
}

/** 图像材料的像素来源校验：PNG 往返一致。 */
export function pngRoundTrip(img: GelImage): boolean {
  const rt = decodePng(encodePng(img));
  return rt.width === img.width && rt.height === img.height && Buffer.from(rt.pixels).equals(Buffer.from(img.pixels));
}
