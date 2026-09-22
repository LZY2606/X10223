/**
 * 分子量推断核心：
 * - 局部标尺：相邻 ladder 点之间按 log10(bp) 对弧长 s 线性插值，每段带有效区域；
 * - “微笑”弯曲：同一像素 y 在不同泳道对应不同弧长 s，因此必须按泳道各自的
 *   中心线把条带中心换算成 s，再查局部标尺；
 * - 饱和/拖尾 -> 区间；重叠 -> 候选集合；非单调 ladder -> 段失效 + 带位置诊断。
 */
import { contentId } from './ids.js';
import { projectOntoPolyline, pointAtS, polylineLength } from './geometry.js';
import type {
  BandObject,
  Diag,
  LadderObject,
  LaneObject,
  MwEstimate,
  ScaleSegment,
  ValidRegion
} from './types.js';

export interface MwParams {
  version: string;
  mode: 'local-log-linear';
  saturationPolicy: 'interval';
  overlapPolicy: 'candidates';
  /** out-of-range: v1 直接判失效；v2 允许钳到边界并给出区间。 */
  edgePolicy: 'reject' | 'clamp-interval';
}

export const MW_PARAMS_V1: MwParams = {
  version: 'mw-interp/v1',
  mode: 'local-log-linear',
  saturationPolicy: 'interval',
  overlapPolicy: 'candidates',
  edgePolicy: 'reject'
};

export const MW_PARAMS_V2: MwParams = {
  ...MW_PARAMS_V1,
  version: 'mw-interp/v2',
  edgePolicy: 'clamp-interval'
};

export interface LadderScalePoint {
  id: string;
  mwBp: number;
  sPx: number;
}

export interface LadderScale {
  ladderId: string;
  points: LadderScalePoint[]; // 按 s 升序
  segments: ScaleSegment[];
  diagnostics: Diag[];
  fit: { a: number; b: number } | null; // log10(bp) = a + b*s 全局拟合
  residuals: { pointId: string; residualLog10: number }[];
}

function diag(code: string, message: string, position?: Diag['position'], severity: 'error' | 'warn' = 'error'): Diag {
  return { id: contentId('diag', { code, message, position }), severity, code, message, position };
}

/** 由 ladder 标称值 + ladder 泳道中心线构建局部标尺。 */
export function buildLadderScale(ladder: LadderObject, ladderLane: LaneObject): LadderScale {
  const diagnostics: Diag[] = [];
  if (ladder.laneId !== ladderLane.id) {
    diagnostics.push(
      diag('ladder/lane-mismatch', `ladder ${ladder.id} 声明的泳道 ${ladder.laneId} 与给定泳道 ${ladderLane.id} 不一致`, {
        objectId: ladder.id,
        laneId: ladderLane.id
      })
    );
  }
  const line = ladderLane.centerline.map((p) => ({ x: p.x, y: p.y }));
  const points: LadderScalePoint[] = ladder.points.map((lp) => ({
    id: lp.id,
    mwBp: lp.mwBp,
    sPx: projectOntoPolyline(line, { x: lp.center.x, y: lp.center.y }).s
  }));
  points.sort((a, b) => a.sPx - b.sPx || a.id.localeCompare(b.id));

  // 非单调检查：s 增大时标称 bp 必须严格减小
  const badJunction = new Set<number>(); // segment index i 连接 points[i] 与 points[i+1]
  for (let i = 0; i < points.length - 1; i++) {
    if (!(points[i].mwBp > points[i + 1].mwBp)) {
      badJunction.add(i);
      diagnostics.push(
        diag(
          'ladder/non-monotonic',
          `ladder 标称值非单调：${points[i].mwBp} bp (s=${points[i].sPx.toFixed(1)}px) 之后出现 ${points[i + 1].mwBp} bp`,
          { objectId: points[i + 1].id, laneId: ladderLane.id }
        )
      );
    }
  }

  const segments: ScaleSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const valid = !badJunction.has(i);
    segments.push({
      id: `seg_${ladder.id.slice(-8)}_${i}`,
      index: i,
      sMinPx: points[i].sPx,
      sMaxPx: points[i + 1].sPx,
      mwAtSMinBp: points[i].mwBp,
      mwAtSMaxBp: points[i + 1].mwBp,
      pointIds: [points[i].id, points[i + 1].id],
      valid,
      invalidReason: valid ? undefined : 'ladder 标称值在该段邻接处非单调'
    });
  }

  // 全局 log 线性拟合（用于残差展示，不参与取值）
  let fit: { a: number; b: number } | null = null;
  const residuals: { pointId: string; residualLog10: number }[] = [];
  if (points.length >= 2) {
    const n = points.length;
    const sx = points.reduce((acc, p) => acc + p.sPx, 0);
    const sy = points.reduce((acc, p) => acc + Math.log10(p.mwBp), 0);
    const sxx = points.reduce((acc, p) => acc + p.sPx * p.sPx, 0);
    const sxy = points.reduce((acc, p) => acc + p.sPx * Math.log10(p.mwBp), 0);
    const denom = n * sxx - sx * sx;
    if (denom !== 0) {
      const b = (n * sxy - sx * sy) / denom;
      const a = (sy - b * sx) / n;
      fit = { a, b };
      for (const p of points) {
        residuals.push({ pointId: p.id, residualLog10: Math.log10(p.mwBp) - (a + b * p.sPx) });
      }
    }
  }
  return { ladderId: ladder.id, points, segments, diagnostics, fit, residuals };
}

/**
 * 微笑校正：每条泳道实际迁移长度不同，条带弧长必须乘以
 * sScale = ladder泳道长度 / 本泳道长度 才能与 ladder 标尺同坐标。
 */
export function laneSScale(lane: LaneObject, ladderLane: LaneObject): number {
  const laneLen = polylineLength(lane.centerline);
  const ladderLen = polylineLength(ladderLane.centerline);
  return laneLen === 0 ? 1 : ladderLen / laneLen;
}

export function validRegionForLane(seg: ScaleSegment, lane: LaneObject, sScale = 1): ValidRegion {
  const line = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
  const pMin = pointAtS(line, seg.sMinPx / sScale);
  const pMax = pointAtS(line, seg.sMaxPx / sScale);
  return {
    sMinPx: seg.sMinPx,
    sMaxPx: seg.sMaxPx,
    yMinPx: Math.min(pMin.y, pMax.y),
    yMaxPx: Math.max(pMin.y, pMax.y),
    basis: lane.centerline[0]?.basis ?? 'image-raw'
  };
}

function mwAtS(seg: ScaleSegment, sPx: number): number {
  const t = seg.sMaxPx === seg.sMinPx ? 0 : (sPx - seg.sMinPx) / (seg.sMaxPx - seg.sMinPx);
  const logMw = Math.log10(seg.mwAtSMinBp) + t * (Math.log10(seg.mwAtSMaxBp) - Math.log10(seg.mwAtSMinBp));
  return Math.pow(10, logMw);
}

export interface EstimateContext {
  /** 重叠组内各峰的弧长位置（含自身），由调用方给出。 */
  overlapPeerS?: number[];
  /** 微笑校正系数：ladder泳道长度 / 本泳道长度。 */
  sScale?: number;
  /** ladder 泳道（用于计算 sScale；与 sScale 二选一）。 */
  ladderLane?: LaneObject;
}

/**
 * 对单个条带做分子量推断。输入不完整时返回 invalid + 带位置诊断，
 * 绝不返回空值或默认分子量。
 */
export function estimateBandMW(
  band: BandObject,
  lane: LaneObject | undefined,
  scale: LadderScale,
  lanesById: Map<string, LaneObject>,
  params: MwParams,
  ctx: EstimateContext = {}
): { estimate: MwEstimate; diagnostics: Diag[] } {
  const diagnostics: Diag[] = [...scale.diagnostics];

  if (!lane) {
    const d = diag('band/lane-missing', `条带 ${band.id} 引用的泳道 ${band.laneId} 不存在，无法定位迁移距离`, {
      objectId: band.id,
      laneId: band.laneId,
      point: band.center
    });
    return { estimate: { kind: 'invalid', reason: 'lane-missing', diagnostic: d }, diagnostics: [...diagnostics, d] };
  }

  const line = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
  const sScale = ctx.sScale ?? (ctx.ladderLane ? laneSScale(lane, ctx.ladderLane) : 1);
  const sRaw = projectOntoPolyline(line, { x: band.center.x, y: band.center.y }).s;
  const s = sRaw * sScale;
  const seg = scale.segments.find((g) => s >= g.sMinPx && s <= g.sMaxPx);

  // 重叠：只能给出候选集合，保留全部合法候选
  if (band.overlapGroupId && params.overlapPolicy === 'candidates') {
    const peers = (ctx.overlapPeerS && ctx.overlapPeerS.length > 0 ? ctx.overlapPeerS : [s]).slice();
    peers.sort((a, b) => a - b);
    const options: { mwBp: number; segmentId: string }[] = [];
    for (const peerS of peers) {
      const peerSeg = scale.segments.find((g) => peerS >= g.sMinPx && peerS <= g.sMaxPx);
      if (peerSeg && peerSeg.valid) {
        options.push({ mwBp: Math.round(mwAtS(peerSeg, peerS)), segmentId: peerSeg.id });
      }
    }
    if (options.length === 0) {
      const d = diag('band/overlap-unresolvable', `重叠条带 ${band.id} 的所有峰位置都落在失效标尺段外`, {
        objectId: band.id,
        point: band.center,
        laneId: lane.id
      });
      return { estimate: { kind: 'invalid', reason: 'overlap-unresolvable', diagnostic: d }, diagnostics: [...diagnostics, d] };
    }
    return { estimate: { kind: 'candidates', reason: 'overlap', options }, diagnostics };
  }

  if (!seg) {
    const d = diag('band/out-of-ladder-range', `条带 ${band.id} 的迁移距离 s=${s.toFixed(1)}px 超出 ladder 覆盖范围`, {
      objectId: band.id,
      point: band.center,
      laneId: lane.id
    });
    if (params.edgePolicy === 'clamp-interval' && scale.segments.length > 0) {
      const edge = s < scale.segments[0].sMinPx ? scale.segments[0] : scale.segments[scale.segments.length - 1];
      const boundaryMw = s < scale.segments[0].sMinPx ? edge.mwAtSMinBp : edge.mwAtSMaxBp;
      diagnostics.push({ ...d, severity: 'warn' });
      return {
        estimate: {
          kind: 'interval',
          loBp: Math.round(Math.min(boundaryMw, boundaryMw * 1.2)),
          hiBp: Math.round(Math.max(boundaryMw, boundaryMw * 1.2)),
          reason: 'smear',
          segmentId: edge.id,
      validRegion: validRegionForLane(edge, lane, sScale)
        },
        diagnostics
      };
    }
    return { estimate: { kind: 'invalid', reason: 'out-of-ladder-range', diagnostic: d }, diagnostics: [...diagnostics, d] };
  }

  if (!seg.valid) {
    const d = diag('scale/segment-invalid', `条带 ${band.id} 落在失效标尺段 ${seg.id}：${seg.invalidReason}`, {
      objectId: band.id,
      segmentId: seg.id,
      laneId: lane.id,
      point: band.center
    });
    return { estimate: { kind: 'invalid', reason: 'segment-invalid', diagnostic: d }, diagnostics: [...diagnostics, d] };
  }

  const region = validRegionForLane(seg, lane, sScale);

  // 饱和/拖尾：只能给区间
  if (band.saturated && params.saturationPolicy === 'interval') {
    const half = band.heightPx / 2;
    const sLo = Math.max(seg.sMinPx, s - half);
    const sHi = Math.min(seg.sMaxPx, s + half);
    const hiBp = mwAtS(seg, sLo); // s 小 -> bp 大
    const loBp = mwAtS(seg, sHi);
    const d = diag(
      'band/saturated-interval',
      `条带 ${band.id} 峰值饱和（${band.peakIntensity}），中心不可信，仅给出区间 [${Math.round(loBp)}, ${Math.round(hiBp)}] bp`,
      { objectId: band.id, segmentId: seg.id, laneId: lane.id, point: band.center },
      'warn'
    );
    return {
      estimate: {
        kind: 'interval',
        loBp: Math.round(loBp),
        hiBp: Math.round(hiBp),
        reason: 'saturated',
        segmentId: seg.id,
        validRegion: region
      },
      diagnostics: [...diagnostics, d]
    };
  }

  const mw = mwAtS(seg, s);
  let residualLog10: number | null = null;
  if (scale.fit) residualLog10 = Math.log10(mw) - (scale.fit.a + scale.fit.b * s);
  return {
    estimate: { kind: 'value', mwBp: Math.round(mw), segmentId: seg.id, validRegion: region, residualLog10 },
    diagnostics
  };
}

/** 重叠组内各峰位置：按轮廓沿泳道方向分解为两个峰（确定性近似）。 */
export function overlapPeerPositions(groupBands: BandObject[], lane: LaneObject, sScale = 1): number[] {
  const line = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
  return groupBands
    .map((b) => projectOntoPolyline(line, { x: b.center.x, y: b.center.y }).s * sScale)
    .sort((a, b) => a - b);
}

/** 稳定排序：等价输入得到稳定顺序（先泳道序号，再弧长，再 id）。 */
export function sortBandsDeterministically(bands: BandObject[], lanesById: Map<string, LaneObject>): BandObject[] {
  const laneIndex = (id: string) => lanesById.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
  return bands.slice().sort((a, b) => {
    const li = laneIndex(a.laneId) - laneIndex(b.laneId);
    if (li !== 0) return li;
    const laneA = lanesById.get(a.laneId);
    const laneB = lanesById.get(b.laneId);
    const sa = laneA ? projectOntoPolyline(laneA.centerline, a.center).s : 0;
    const sb = laneB ? projectOntoPolyline(laneB.centerline, b.center).s : 0;
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });
}
