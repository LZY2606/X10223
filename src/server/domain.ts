import type {
  BandCenterMaterial,
  BandResult,
  Diagnostic,
  Event,
  GelImageMaterial,
  GelParams,
  InterpSegment,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  LaneSpec,
  Material,
  PixelPoint,
  Transform
} from '../shared/types.js';
import { digestOf } from '../shared/canon.js';

export interface BranchInput {
  branch: string;
  materials: Material[];
  params: GelParams;
  decisions: Event[]; // human-decision / conflict-resolved 事件
  eventId: string;
}

// —— 坐标变换：原图像素 -> 工作像素（含旋转/镜像）——
export function applyTransform(
  x: number,
  y: number,
  w: number,
  h: number,
  t: Transform
): { x: number; y: number; w: number; h: number } {
  let nx = x;
  let ny = y;
  if (t.mirrored) nx = w - 1 - nx;
  const r = t.rotationDeg;
  let W = w;
  let H = h;
  if (r === 90 || r === 270) {
    const ox = nx;
    nx = r === 90 ? H - 1 - y : y;
    ny = r === 90 ? ox : w - 1 - ox;
    W = h;
    H = w;
  } else if (r === 180) {
    nx = w - 1 - nx;
    ny = h - 1 - ny;
  }
  return { x: nx, y: ny, w: W, h: H };
}

function diag(code: Diagnostic['code'], message: string, location: Diagnostic['location'] = {}): Diagnostic {
  return { code, message, location };
}

// 折线累计弧长（向下为正方向，像素级来源点）
function polylineArcLength(points: PixelPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

// 在中心线上按目标 y（及给定 x）取最接近的折线段，返回沿弯曲线的迁移距离
function migrationAlongCurve(lane: LaneSpec, x: number, y: number): number {
  const pts = lane.centerline;
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestFrac = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1e-9;
    const frac = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
    const px = a.x + frac * vx;
    const py = a.y + frac * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
      bestFrac = frac;
    }
  }
  let arc = 0;
  for (let i = 0; i < bestSeg; i++) {
    arc += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  const segA = pts[bestSeg];
  const segB = pts[bestSeg + 1];
  arc += bestFrac * Math.hypot(segB.x - segA.x, segB.y - segA.y);
  return arc;
}

interface RulerPoint {
  bandIndex: number;
  arc: number; // 沿 ladder 泳道曲线的迁移距离 px
  logSize: number;
  y: number; // ladder lane 像素 y
  sizeBp: number;
  missing: boolean;
}

interface Ruler {
  points: RulerPoint[];
  segments: InterpSegment[];
  diagnostics: Diagnostic[];
  laneId: string;
  ladderLength: number;
  residuals: { bandIndex: number; yPx: number; residualLog10: number }[];
}

function buildLadderRuler(
  lane: LaneSpec,
  bands: BandCenterMaterial | undefined,
  nominal: LadderNominalMaterial,
  params: GelParams
): Ruler | { diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!bands) {
    diagnostics.push(
      diag('incomplete-input', `ladder 泳道 ${lane.laneId} 缺少条带中心材料`, { laneId: lane.laneId })
    );
    return { diagnostics };
  }
  const byIndex = new Map(bands.bands.map((b) => [b.bandIndex, b]));
  const points: RulerPoint[] = [];
  for (let i = 0; i < nominal.valuesBp.length; i++) {
    const b = byIndex.get(i);
    const sizeBp = nominal.valuesBp[i];
    if (!b) {
      diagnostics.push(
        diag('missing-ladder-band', `ladder 缺带：第 ${i} 档（${sizeBp} bp）未检出`, {
          laneId: lane.laneId,
          bandIndex: i
        })
      );
      continue;
    }
    points.push({
      bandIndex: i,
      arc: migrationAlongCurve(lane, b.x, b.y),
      logSize: Math.log10(sizeBp),
      y: b.y,
      sizeBp,
      missing: false
    });
  }

  // 非单调标尺：迁移距离必须随分子量减小而单调增加
  const nonMonoIndexes = new Set<number>();
  for (let i = 1; i < points.length; i++) {
    if (points[i].arc <= points[i - 1].arc) {
      nonMonoIndexes.add(i - 1);
      nonMonoIndexes.add(i);
      diagnostics.push(
        diag('non-monotonic-ruler', `非单调标尺：第 ${points[i - 1].bandIndex}/${points[i].bandIndex} 档迁移距离未增加`, {
          laneId: lane.laneId,
          bandIndex: points[i].bandIndex
        })
      );
    }
  }
  const presentIndexes = new Set(nominal.valuesBp.map((_, i) => i));
  bands.bands.forEach(() => void 0);
  const missingIndexes = new Set<number>();
  for (let i = 0; i < nominal.valuesBp.length; i++) if (!byIndex.get(i)) missingIndexes.add(i);

  // 最小二乘 log10(size) = a*arc + b，残差作为拟合证据
  const n = points.length;
  const meanArc = points.reduce((s, p) => s + p.arc, 0) / n;
  const meanLog = points.reduce((s, p) => s + p.logSize, 0) / n;
  const denom = points.reduce((s, p) => s + (p.arc - meanArc) ** 2, 0) || 1e-9;
  const slope = points.reduce((s, p) => s + (p.arc - meanArc) * (p.logSize - meanLog), 0) / denom;
  const intercept = meanLog - slope * meanArc;
  const residuals = points.map((p) => ({
    bandIndex: p.bandIndex,
    yPx: p.y,
    residualLog10: p.logSize - (slope * p.arc + intercept)
  }));

  const segments: InterpSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const gapBands = p1.bandIndex - p0.bandIndex - 1;
    const degraded =
      nonMonoIndexes.has(p0.bandIndex) || nonMonoIndexes.has(p1.bandIndex) || gapBands > 0;
    segments.push({
      index: i,
      y0: p0.arc,
      y1: p1.arc,
      logSize0: p0.logSize,
      logSize1: p1.logSize,
      degraded,
      reason: nonMonoIndexes.has(p0.bandIndex) || nonMonoIndexes.has(p1.bandIndex)
        ? 'non-monotonic-ruler'
        : gapBands > 0
          ? `ladder-gap:${gapBands}`
          : undefined
    });
  }
  void presentIndexes;
  void missingIndexes;
  void params;
  return { points, segments, diagnostics, laneId: lane.laneId, ladderLength: polylineArcLength(lane.centerline), residuals };
}

type BuiltRuler = ReturnType<typeof buildLadderRuler>;
function isRuler(r: BuiltRuler): r is Ruler {
  return 'segments' in r && (r as Ruler).segments !== undefined;
}

function arcToYOnCurve(lane: LaneSpec, targetArc: number): number {
  const pts = lane.centerline;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const segLen = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (acc + segLen >= targetArc) {
      const frac = segLen === 0 ? 0 : (targetArc - acc) / segLen;
      return pts[i].y + frac * (pts[i + 1].y - pts[i].y);
    }
    acc += segLen;
  }
  return pts[pts.length - 1].y;
}

export interface BranchComputation {
  results: BandResult[];
  diagnostics: Diagnostic[];
  ladder?: {
    laneId: string;
    points: { bandIndex: number; yPx: number; sizeBp: number; missing: boolean }[];
    residuals: { bandIndex: number; yPx: number; residualLog10: number }[];
  };
  inputDigest: string;
}

export function computeBranch(input: BranchInput): BranchComputation {
  const { branch, materials, params, decisions } = input;
  const diagnostics: Diagnostic[] = [];
  const image = materials.find((m): m is GelImageMaterial => m.kind === 'image');
  const nominal = materials.find((m): m is LadderNominalMaterial => m.kind === 'ladder-nominal');
  const boundaries = materials.find((m): m is LaneBoundaryMaterial => m.kind === 'lane-boundaries');
  const bandsByLane = new Map<string, BandCenterMaterial>();
  for (const m of materials) if (m.kind === 'band-centers') bandsByLane.set(m.laneId, m);

  if (!image) diagnostics.push(diag('incomplete-input', '缺少凝胶原图材料'));
  if (image && !image.orientation)
    diagnostics.push(diag('missing-orientation', '拍摄方向未声明，不使用默认值伪装', { materialId: image.id }));
  if (image && !image.exposure)
    diagnostics.push(diag('missing-exposure', '曝光参数未声明', { materialId: image.id }));
  if (!nominal) diagnostics.push(diag('incomplete-input', '缺少 ladder 标称值材料'));
  if (!boundaries) diagnostics.push(diag('incomplete-input', '缺少泳道边界材料'));

  if (!image || !nominal || !boundaries) {
    return {
      results: [],
      diagnostics,
      inputDigest: digestOf({ branch, materials: materials.map((m) => m.id), params: params.paramsVersion })
    };
  }

  const basis = {
    imageId: image.id,
    transform: image.orientation ?? { rotationDeg: 0 as const, mirrored: false },
    origin: 'top-left' as const,
    axes: 'x-right/y-down' as const,
    unit: 'px' as const
  };

  const ladderLane = boundaries.lanes.find((l) => l.role === 'ladder');
  if (!ladderLane) {
    diagnostics.push(diag('incomplete-input', '未指定 ladder 泳道'));
    return { results: [], diagnostics, inputDigest: '' };
  }
  const ladderBands = bandsByLane.get(ladderLane.laneId);
  const rulerBuild = buildLadderRuler(ladderLane, ladderBands, nominal, params);
  if (!isRuler(rulerBuild)) {
    return { results: [], diagnostics: [...diagnostics, ...rulerBuild.diagnostics], inputDigest: '' };
  }
  diagnostics.push(...rulerBuild.diagnostics);

  const minArc = Math.min(...rulerBuild.points.map((p) => p.arc));
  const maxArc = Math.max(...rulerBuild.points.map((p) => p.arc));

  const results: BandResult[] = [];

  for (const lane of boundaries.lanes) {
    if (lane.role !== 'sample') continue;
    const bc = bandsByLane.get(lane.laneId);
    if (!bc) {
      diagnostics.push(diag('incomplete-input', `样本泳道 ${lane.laneId} 缺少条带中心`, { laneId: lane.laneId }));
      continue;
    }
    // 重叠检测：同泳道相邻条带间距低于阈值
    const overlapGroups = new Map<number, number[]>();
    const ordered = [...bc.bands].sort((a, b) => a.y - b.y);
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (b.y - a.y < params.minBandSeparationPx) {
        const ga = overlapGroups.get(a.bandIndex) ?? [a.bandIndex];
        const gb = overlapGroups.get(b.bandIndex) ?? [b.bandIndex];
        const merged = Array.from(new Set([...ga, ...gb]));
        merged.forEach((idx) => overlapGroups.set(idx, merged));
      }
    }

    for (const band of bc.bands) {
      const localDiags: Diagnostic[] = [];
      const arc = migrationAlongCurve(lane, band.x, band.y);
      const yMinPx = arcToYOnCurve(lane, minArc);
      const yMaxPx = arcToYOnCurve(lane, maxArc);

      let status: BandResult['status'] = 'ok';
      let sizeBp: number | null = null;
      let intervalBp: BandResult['intervalBp'] = null;
      const candidatesBp: number[] = [];
      let failureReason: string | null = null;
      let segmentIndex: number | null = null;

      if (arc < minArc || arc > maxArc) {
        status = 'invalid';
        failureReason = 'outside-valid-region';
        localDiags.push(
          diag('outside-valid-region', `条带迁移 ${arc.toFixed(1)}px 超出局部标尺有效区域 [${minArc.toFixed(1)}, ${maxArc.toFixed(1)}]px`, {
            laneId: lane.laneId,
            bandIndex: band.bandIndex,
            pixel: { x: band.x, y: band.y }
          })
        );
      } else {
        const seg = rulerBuild.segments
          .filter((s) => arc >= Math.min(s.y0, s.y1) && arc <= Math.max(s.y0, s.y1))
          .sort((a, b) => a.index - b.index)[0];
        if (seg) {
          segmentIndex = seg.index;
          const frac = (arc - seg.y0) / ((seg.y1 - seg.y0) || 1e-9);
          const logSize = seg.logSize0 + frac * (seg.logSize1 - seg.logSize0);
          sizeBp = 10 ** logSize;
          if (seg.reason?.startsWith('non-monotonic')) {
            status = 'invalid';
            failureReason = 'non-monotonic-ruler';
            sizeBp = null;
          } else if (seg.degraded) {
            status = 'candidate';
            failureReason = seg.reason ?? 'degraded-segment';
            candidatesBp.push(10 ** logSize);
          }
        }
      }

      // 饱和：只能给区间
      if (band.saturated || band.intensity >= params.saturationThreshold) {
        if (status === 'ok') status = 'interval';
        failureReason = failureReason ?? 'saturated-band';
        const arcHi = migrationAlongCurve(lane, band.x, band.y - band.halfWidthPx);
        const arcLo = migrationAlongCurve(lane, band.x, band.y + band.halfWidthPx);
        const toSize = (a: number) => {
          const s = rulerBuild.segments.find(
            (x) => a >= Math.min(x.y0, x.y1) && a <= Math.max(x.y0, x.y1)
          );
          if (!s) return null;
          const f = (a - s.y0) / ((s.y1 - s.y0) || 1e-9);
          return 10 ** (s.logSize0 + f * (s.logSize1 - s.logSize0));
        };
        const hi = toSize(Math.max(arcHi, minArc));
        const lo = toSize(Math.min(arcLo, maxArc));
        if (lo !== null && hi !== null) intervalBp = { lo, hi: Math.max(hi, lo) };
        if (sizeBp !== null) candidatesBp.push(sizeBp);
        sizeBp = null;
        localDiags.push(
          diag('saturated-band', '饱和条带中心不可精确定位，仅输出候选/区间', {
            laneId: lane.laneId,
            bandIndex: band.bandIndex,
            pixel: { x: band.x, y: band.y }
          })
        );
      }
      if (band.tailing) {
        if (status === 'ok') status = 'candidate';
        failureReason = failureReason ?? 'tailing-band';
        if (sizeBp !== null) {
          candidatesBp.push(sizeBp);
          sizeBp = null;
        }
        localDiags.push(
          diag('tailing-band', '拖尾条带仅可作为候选', {
            laneId: lane.laneId,
            bandIndex: band.bandIndex,
            pixel: { x: band.x, y: band.y }
          })
        );
      }
      const overlaps = overlapGroups.get(band.bandIndex);
      if (overlaps && overlaps.length > 1) {
        if (status === 'ok') status = 'candidate';
        failureReason = failureReason ?? 'overlapping-bands';
        localDiags.push(
          diag('overlapping-bands', `条带与第 ${overlaps.filter((i) => i !== band.bandIndex).join(',')} 档重叠，保留全部合法候选`, {
            laneId: lane.laneId,
            bandIndex: band.bandIndex,
            pixel: { x: band.x, y: band.y }
          })
        );
      }
      // 收集重叠组内所有候选分子量
      if (overlaps) {
        for (const idx of overlaps) {
          if (idx === band.bandIndex) continue;
          const other = bc.bands.find((b) => b.bandIndex === idx);
          if (other) {
            const otherArc = migrationAlongCurve(lane, other.x, other.y);
            const s = rulerBuild.segments.find(
              (x) => otherArc >= Math.min(x.y0, x.y1) && otherArc <= Math.max(x.y0, x.y1)
            );
            if (s) {
              const f = (otherArc - s.y0) / ((s.y1 - s.y0) || 1e-9);
              candidatesBp.push(10 ** (s.logSize0 + f * (s.logSize1 - s.logSize0)));
            }
          }
        }
      }
      if (candidatesBp.length && sizeBp !== null && status !== 'ok') candidatesBp.unshift(sizeBp);

      const laneMaterial = materials.find(
        (m) => m.kind === 'lane-boundaries'
      ) as LaneBoundaryMaterial;
      const bcMaterial = bc.id;
      const parents = [image.id, nominal.id, laneMaterial.id, bcMaterial, params.paramsVersion, input.eventId];
      // 身份只依赖该泳道/条带的直接来源几何与材料：局部源改动必须只影响对应结果
      const laneFingerprint = digestOf([lane.laneId, lane.centerline]);
      const bandFingerprint = digestOf([
        lane.laneId,
        band.bandIndex,
        band.x,
        band.y,
        band.intensity,
        band.saturated,
        band.tailing,
        band.halfWidthPx
      ]);
      const resultId =
        'res-' +
        digestOf([
          branch,
          lane.laneId,
          band.bandIndex,
          laneFingerprint,
          bandFingerprint,
          nominal.id,
          image.id,
          params.paramsVersion
        ]).slice(7, 23);

      results.push({
        resultId,
        branch,
        laneId: lane.laneId,
        bandIndex: band.bandIndex,
        status,
        sizeBp,
        intervalBp,
        candidatesBp: Array.from(new Set(candidatesBp.map((v) => Math.round(v * 100) / 100))).sort((a, b) => b - a),
        unit: 'bp',
        basis,
        validRegion: { yMinPx: Math.min(yMinPx, yMaxPx), yMaxPx: Math.max(yMinPx, yMaxPx) },
        failureReason,
        diagnostics: localDiags,
        ladderPoints: rulerBuild.points.map((p) => ({ bandIndex: p.bandIndex, yPx: p.y, sizeBp: p.sizeBp, missing: false })),
        segmentIndex,
        segments: rulerBuild.segments,
        residuals: rulerBuild.residuals,
        parents,
        eventId: input.eventId,
        adopted: null
      });
      diagnostics.push(...localDiags);
    }
  }

  // 人工决定：采纳 / 否定 / 参数调整；冲突解决后以胜出决定为准
  const byTarget = new Map<string, Event[]>();
  for (const d of decisions) {
    const key = `${d.payload.laneId}:${d.payload.bandIndex}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), d]);
  }
  const resolution = decisions.find((d) => d.type === 'conflict-resolved');
  for (const r of results) {
    const list = byTarget.get(`${r.laneId}:${r.bandIndex}`);
    if (!list || list.length === 0) continue;
    let chosen = list[list.length - 1];
    if (resolution) {
      const winnerId = resolution.payload.winningEventId as string;
      chosen = list.find((d) => d.id === winnerId) ?? chosen;
    }
    const verdict = chosen.payload.verdict as 'accept' | 'reject' | 'adjust';
    r.adopted = verdict === 'reject' ? false : true;
    if (verdict === 'adjust' && typeof chosen.payload.adjustedSizeBp === 'number') {
      r.sizeBp = chosen.payload.adjustedSizeBp as number;
      r.status = 'ok';
      r.failureReason = null;
      r.parents = [...r.parents, chosen.id];
    } else {
      r.parents = [...r.parents, chosen.id];
    }
  }

  return {
    results,
    diagnostics,
    ladder: {
      laneId: ladderLane.laneId,
      points: nominal.valuesBp.map((sizeBp, i) => {
        const p = rulerBuild.points.find((q) => q.bandIndex === i);
        return { bandIndex: i, yPx: p?.y ?? NaN, sizeBp, missing: !p };
      }),
      residuals: rulerBuild.residuals
    },
    inputDigest: digestOf({
      branch,
      materials: materials.map((m) => [m.id, m.kind]).sort(),
      paramsVersion: params.paramsVersion,
      event: input.eventId
    })
  };
}
