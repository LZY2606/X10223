import type { BandRecord, DetectorParams, Diagnostic, ImageMaterial, LaneRecord, PixelPoint } from './types.js';
import { contentId } from './ids.js';
import { diag } from './diagnostics.js';
import { makePixelPoint, projectToCurve, sampleCurve } from './geometry.js';
import type { Size } from './geometry.js';

interface DetectionContext {
  image: ImageMaterial;
  /** 当前修正方向后的灰度帧 */
  gray: Uint8Array;
  size: Size;
  turns: number;
  native: Size;
  params: DetectorParams;
}

function smooth(arr: number[], win: number): number[] {
  const half = Math.max(1, win >> 1);
  return arr.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      s += arr[j];
      n++;
    }
    return s / n;
  });
}

function findRuns(mask: boolean[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < mask.length) {
    if (mask[i]) {
      const start = i;
      while (i < mask.length && mask[i]) i++;
      runs.push({ start, end: i - 1 });
    } else i++;
  }
  return runs;
}

/**
 * 泳道检测：对每列求平均暗度（条带亮于背景，使用 255-gray 作为“信号”），
 * 横向平滑后按阈值切分泳道；再逐行求重心得到（可能弯曲的）中心线。
 */
export function detectLanes(ctx: DetectionContext): { lanes: LaneRecord[]; diagnostics: Diagnostic[] } {
  const { gray, size, params } = ctx;
  const colSignal = new Array(size.width).fill(0);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      colSignal[x] += 255 - gray[y * size.width + x];
    }
  }
  for (let x = 0; x < size.width; x++) colSignal[x] /= size.height;
  const smoothed = smooth(colSignal, params.laneBandwidth);
  const maxSig = Math.max(...smoothed, 1);
  const threshold = Math.min(params.laneDarkThreshold, maxSig * 0.25);
  const mask = smoothed.map((v) => v >= threshold);
  const runs = findRuns(mask)
    .filter((r) => r.end - r.start >= 3)
    .slice(0, params.maxLanes);

  const diagnostics: Diagnostic[] = [];
  if (runs.length === 0) {
    diagnostics.push(diag('INPUT_INCOMPLETE', 'warning', '未检测到任何泳道：图像信号过低或方向错误', { kind: 'image' }));
  }

  const lanes: LaneRecord[] = runs.map((run, index) => {
    const left = run.start;
    const right = run.end;
    const rows: { x: number; y: number }[] = [];
    const step = Math.max(4, Math.round(size.height / 40));
    for (let y = step; y < size.height - step; y += step) {
      let num = 0;
      let den = 0;
      for (let x = left; x <= right; x++) {
        const s = 255 - gray[y * size.width + x];
        num += x * s;
        den += s;
      }
      if (den > 0) rows.push({ x: num / den, y });
    }
    const centerControls = rows.length >= 2 ? rows : [{ x: (left + right) / 2, y: step }, { x: (left + right) / 2, y: size.height - step }];
    const boundaryControls = centerControls.map((p) => ({ x: left, y: p.y }));
    const boundaryR = centerControls.map((p) => ({ x: right, y: p.y }));
    const cp = centerControls.map((p) => makePixelPoint(p.x, p.y, ctx.native, ctx.turns));
    const well = makePixelPoint((left + right) / 2, Math.min(...centerControls.map((p) => p.y)), ctx.native, ctx.turns);
    const id = contentId('lane', { index, controls: cp.map((p) => [round(p.x), round(p.y)]) });
    return {
      id,
      index,
      leftBoundary: boundaryControls.map((p) => makePixelPoint(p.x, p.y, ctx.native, ctx.turns)),
      rightBoundary: boundaryR.map((p) => makePixelPoint(p.x, p.y, ctx.native, ctx.turns)),
      centerline: { type: 'auto', controlPoints: cp, detectionInputSummary: '' },
      status: 'candidate',
      well,
      confidence: Math.min(1, Number((maxSig / 90).toFixed(2))),
    };
  });

  return { lanes, diagnostics };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Peak {
  row: number;
  top: number;
  bottom: number;
  prominence: number;
  width: number;
  saturatedPixels: number;
  maxIntensity: number;
  profile: number[];
}

function laneProfile(ctx: DetectionContext, lane: LaneRecord): number[] {
  const cps = lane.centerline.controlPoints.map((p) => ({ x: p.x, y: p.y }));
  const curve = sampleCurve(cps, 8);
  const profile = new Array(ctx.size.height).fill(0);
  const counts = new Array(ctx.size.height).fill(0);
  const halfWidth = Math.max(
    2,
    Math.round(
      (lane.rightBoundary[Math.floor(lane.rightBoundary.length / 2)].x -
        lane.leftBoundary[Math.floor(lane.leftBoundary.length / 2)].x) /
        2.6,
    ),
  );
  for (const cp of curve.points) {
    const y = Math.round(cp.y);
    if (y < 0 || y >= ctx.size.height) continue;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const x = Math.round(cp.x + dx);
      if (x < 0 || x >= ctx.size.width) continue;
      profile[y] += 255 - ctx.gray[y * ctx.size.width + x];
      counts[y]++;
    }
  }
  return profile.map((v, i) => (counts[i] ? v / counts[i] : 0));
}

function findPeaks(profile: number[], params: DetectorParams, saturationLevel: number, gray: Uint8Array, size: Size, lane: LaneRecord): Peak[] {
  const smoothed = smooth(profile, params.bandMinHeight);
  const runs = findRuns(smoothed.map((v) => v >= params.bandProminence));
  const peaks: Peak[] = [];
  const cps = lane.centerline.controlPoints.map((p) => ({ x: p.x, y: p.y }));
  const curve = sampleCurve(cps, 8);
  for (const run of runs) {
    let row = run.start;
    let max = -1;
    for (let y = run.start; y <= run.end; y++) {
      if (smoothed[y] > max) {
        max = smoothed[y];
        row = y;
      }
    }
    const baseline = Math.min(smoothed[run.start], smoothed[Math.min(smoothed.length - 1, run.end)]);
    const prominence = max - baseline;
    if (prominence < params.bandProminence) continue;
    const cp = pointNearRow(curve, row);
    let saturatedPixels = 0;
    let maxIntensity = 0;
    const halfW = 3;
    for (let y = Math.max(0, run.start - 1); y <= Math.min(size.height - 1, run.end + 1); y++) {
      for (let dx = -halfW; dx <= halfW; dx++) {
        const x = Math.round(cp.x + dx);
        if (x < 0 || x >= size.width) continue;
        const v = gray[y * size.width + x];
        if (v >= saturationLevel) saturatedPixels++;
        if (v > maxIntensity) maxIntensity = v;
      }
    }
    peaks.push({
      row,
      top: run.start,
      bottom: run.end,
      prominence,
      width: run.end - run.start + 1,
      saturatedPixels,
      maxIntensity,
      profile: smoothed.slice(run.start, run.end + 1),
    });
  }
  return peaks.slice(0, params.maxBandsPerLane);
}

function pointNearRow(curve: ReturnType<typeof sampleCurve>, y: number): { x: number; y: number } {
  let best = curve.points[0];
  let bd = Infinity;
  for (const p of curve.points) {
    const d = Math.abs(p.y - y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** 条带检测：沿泳道中心线采样纵向信号剖面，找峰并标注饱和/拖尾/重叠 */
export function detectBands(
  ctx: DetectionContext,
  lane: LaneRecord,
): { bands: BandRecord[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const profile = laneProfile(ctx, lane);
  const saturationLevel = Math.min(ctx.params.saturationThreshold, ctx.image.exposure.saturationLevel + 5);
  const peaks = findPeaks(profile, ctx.params, saturationLevel, ctx.gray, ctx.size, lane);
  const curve = sampleCurve(
    lane.centerline.controlPoints.map((p) => ({ x: p.x, y: p.y })),
    10,
  );

  const raw: Array<{ peak: Peak; band: BandRecord }> = peaks.map((peak) => {
    const cp = pointNearRow(curve, peak.row);
    const center = makePixelPoint(cp.x, cp.y, ctx.native, ctx.turns);
    const proj = projectToCurve(curve, cp);
    const width = Math.max(
      2,
      Math.round(
        (lane.rightBoundary[Math.floor(lane.rightBoundary.length / 2)].x -
          lane.leftBoundary[Math.floor(lane.leftBoundary.length / 2)].x) * 0.5,
      ),
    );
    const id = contentId('band', {
      lane: lane.id,
      center: [round(center.x), round(center.y)],
      max: peak.maxIntensity,
    });
    const saturated = peak.saturatedPixels > 0 || peak.maxIntensity >= saturationLevel;
    return {
      peak,
      band: {
        id,
        laneId: lane.id,
        center,
        width,
        height: peak.width,
        migration: round(proj.arc),
        peakIntensity: peak.maxIntensity,
        saturated,
        saturatedPixelCount: peak.saturatedPixels,
        smear: false,
        overlapsWith: [],
        status: 'candidate',
        source: 'auto',
      },
    };
  });

  // 重叠：峰间距小于分离阈值
  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const gap = Math.abs(raw[j].peak.row - raw[i].peak.row);
      if (gap < Math.max(raw[i].peak.width, raw[j].peak.width) || gap < ctx.params.overlapSeparationPx) {
        raw[i].band.overlapsWith.push(raw[j].band.id);
        raw[j].band.overlapsWith.push(raw[i].band.id);
      }
    }
  }

  for (let i = 0; i < raw.length; i++) {
    const { peak, band } = raw[i];
    // 拖尾：峰下方（迁移更大方向）信号缓慢衰减，剖面宽度/高度比异常
    const half = Math.ceil(peak.profile.length / 2);
    const headMass = peak.profile.slice(0, half).reduce((a, b) => a + b, 0);
    const tailMass = peak.profile.slice(half).reduce((a, b) => a + b, 0);
    if (tailMass > headMass * ctx.params.smearTailRatio && peak.width > params_bandMin(ctx)) {
      band.smear = true;
    }
    if (band.saturated) {
      diagnostics.push(
        diag('SATURATED_BAND', 'warning', `条带中心灰度 ${peak.maxIntensity} 达到饱和阈值 ${saturationLevel}，只能给区间`, {
          kind: 'band',
          point: band.center,
          bandId: band.id,
          laneId: lane.id,
        }),
      );
    }
    if (band.smear) {
      diagnostics.push(
        diag('SMEAR_TAIL', 'warning', '检测到拖尾，迁移距离不可唯一确定，只能标为候选或区间', {
          kind: 'band',
          point: band.center,
          bandId: band.id,
          laneId: lane.id,
        }),
      );
    }
    if (band.overlapsWith.length) {
      diagnostics.push(
        diag('OVERLAPPING_BANDS', 'warning', '两条带重叠，保留全部合法候选，不强制唯一中心', {
          kind: 'band',
          point: band.center,
          ids: [band.id, ...band.overlapsWith],
          laneId: lane.id,
        }),
      );
    }
  }

  return { bands: raw.map((r) => r.band), diagnostics };
}

function params_bandMin(ctx: DetectionContext): number {
  return ctx.params.bandMinHeight;
}

/** 弯曲度：中心线各点对最优拟合直线的横向偏移（px）。 */
export function laneSmileMetric(lane: LaneRecord): { maxOffset: number; rmsOffset: number } {
  const pts = lane.centerline.controlPoints.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  if (n < 3) return { maxOffset: 0, rmsOffset: 0 };
  const y0 = pts[0].y;
  const y1 = pts[n - 1].y;
  const x0 = pts[0].x;
  const x1 = pts[n - 1].x;
  const dx = x1 - x0;
  const dy = y1 - y0 || 1;
  const len = Math.hypot(dx, dy);
  let maxOff = 0;
  let sq = 0;
  for (const p of pts) {
    const off = Math.abs(dy * (p.x - x0) - dx * (p.y - y0)) / len;
    maxOff = Math.max(maxOff, off);
    sq += off * off;
  }
  return { maxOffset: round(maxOff), rmsOffset: round(Math.sqrt(sq / n)) };
}
