import type {
  CaptureMaterial,
  DerivedBand,
  DerivedLane,
  Diagnostic,
  PixelPoint,
  Quantity,
  RuleVersion,
} from './types.js';
import type { Raster16 } from './image.js';
import { detectPeaks, sampleLaneProfile } from './image.js';
import { polylineLength } from './geometry.js';
import type { Pt } from './geometry.js';
import { q } from './quantities.js';
import { contentId } from './ids.js';

export interface DetectedLanes {
  lanes: DerivedLane[];
  diagnostics: Diagnostic[];
}

interface TrackedLane {
  xs: number[];
  yStart: number;
}

/** 列投影 + 逐行质心跟踪，允许车道弯曲。 */
export function detectLanes(
  raster: Raster16,
  capture: CaptureMaterial,
  rule: RuleVersion,
): DetectedLanes {
  const thr = Number(rule.params.laneProjectionThreshold);
  const minW = Number(rule.params.minLaneWidthPx);
  const col: number[] = new Array(raster.width).fill(0);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      col[x]! += raster.data[y * raster.width + x]! / raster.maxSensorValue;
    }
  }
  // 轻度滑动平均
  const sm = col.map((v, x) => {
    let s = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      if (x + k >= 0 && x + k < col.length) {
        s += col[x + k]!;
        n++;
      }
    }
    return s / n;
  });
  const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
  const active = sm.map((v) => v > mean + thr * mean * 3);
  const ranges: [number, number][] = [];
  for (let x = 0; x < raster.width; x++) {
    if (!active[x]) continue;
    const start = x;
    while (x < raster.width && active[x]) x++;
    if (x - start >= minW) ranges.push([start, x]);
  }
  // 过近区间合并
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] - prev[1] < 6) prev[1] = r[1];
    else merged.push([...r] as [number, number]);
  }

  const diagnostics: Diagnostic[] = [];
  const lanes: DerivedLane[] = [];
  for (let li = 0; li < merged.length; li++) {
    const [xLo0, xHi0] = merged[li]!;
    const half = Math.round((xHi0 - xLo0) / 2);
    // 质心跟踪
    const track: TrackedLane = { xs: [], yStart: 0 };
    const window = half + 3;
    for (let y = 0; y < raster.height; y++) {
      const prevCx = track.xs.length ? track.xs[track.xs.length - 1]! : (xLo0 + xHi0) / 2;
      const lo = Math.max(0, Math.round(prevCx - window));
      const hi = Math.min(raster.width - 1, Math.round(prevCx + window));
      let num = 0;
      let den = 0;
      for (let x = lo; x <= hi; x++) {
        const v = raster.data[y * raster.width + x]! / raster.maxSensorValue;
        num += v * x;
        den += v;
      }
      const cx = den > 0.02 ? num / den : prevCx;
      track.xs.push(cx);
    }
    // 稀疏化成折线
    const centerPts: Pt[] = [];
    const step = Math.max(4, Math.floor(raster.height / 60));
    for (let y = 0; y < raster.height; y += step) centerPts.push({ x: track.xs[y]!, y });
    centerPts.push({ x: track.xs[raster.height - 1]!, y: raster.height - 1 });

    const laneId = contentId('lane', [capture.id, li, merged]);
    const basis = `${capture.id} 自动检测（${rule.id}）`;
    const mk = (p: Pt): PixelPoint => ({
      x: p.x,
      y: p.y,
      unit: 'px',
      imageVersionId: capture.id,
      transformChain: [],
      basis: 'auto-candidate',
    });
    const centerline = centerPts.map(mk);
    const leftBoundary = centerPts.map((p) => mk({ x: p.x - half, y: p.y }));
    const rightBoundary = centerPts.map((p) => mk({ x: p.x + half, y: p.y }));
    const arcLength: Quantity = q(polylineLength(centerPts), 'arc-length-px', basis);
    lanes.push({
      laneId,
      role: li === 0 || li === merged.length - 1 ? 'ladder' : 'sample',
      label: li === 0 ? 'L-left' : li === merged.length - 1 && merged.length > 1 ? 'L-right' : `S${li}`,
      centerline,
      leftBoundary,
      rightBoundary,
      arcLength,
      quality: 1,
    });
  }
  if (lanes.length < 2) {
    diagnostics.push({
      code: 'INCOMPLETE_INPUT',
      severity: 'error',
      message: `检测到 ${lanes.length} 条泳道，至少需要 2 条（含 ladder）`,
    });
  }
  return { lanes, diagnostics };
}

export interface DetectedBands {
  bands: DerivedBand[];
  diagnostics: Diagnostic[];
}

/** 沿每条车道采样剖面并检测峰，标注饱和/拖尾/重叠。 */
export function detectBands(
  raster: Raster16,
  lanes: DerivedLane[],
  capture: CaptureMaterial,
  rule: RuleVersion,
): DetectedBands {
  const opt = {
    peakThreshold: Number(rule.params.peakThreshold),
    saturationThreshold: Number(rule.params.saturationThreshold),
    smearRatio: Number(rule.params.smearRatio),
    minPeakSeparation: Number(rule.params.minPeakSeparationPx),
    overlapValleyRatio: Number(rule.params.overlapValleyRatio),
  };
  const diagnostics: Diagnostic[] = [];
  const bands: DerivedBand[] = [];
  for (const lane of lanes) {
    const pts: Pt[] = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
    const half = Math.round(
      (lane.rightBoundary[Math.floor(lane.rightBoundary.length / 2)]!.x -
        lane.leftBoundary[Math.floor(lane.leftBoundary.length / 2)]!.x) /
        2,
    );
    const profile = sampleLaneProfile(raster, pts, half, 1);
    const peaks = detectPeaks(profile, opt);
    const basis = `${capture.id}/${lane.laneId} 自动检测（${rule.id}）`;
    for (let pi = 0; pi < peaks.length; pi++) {
      const peak = peaks[pi]!;
      const cp = pts[Math.min(pts.length - 1, Math.round(peak.s))]!;
      const center: PixelPoint = {
        x: cp.x,
        y: cp.y,
        unit: 'px',
        imageVersionId: capture.id,
        transformChain: [],
        basis: 'auto-candidate',
      };
      const neighborIndexes = (peak as BandProfileExt).neighborIndexes ?? [];
      const overlapsWith = neighborIndexes.map((j) =>
        contentId('band', [capture.id, lane.laneId, peaks[j]!.s]),
      );
      const bandId = contentId('band', [capture.id, lane.laneId, peak.s]);
      bands.push({
        bandId,
        laneId: lane.laneId,
        center,
        migration: q(peak.s, 'arc-length-px', basis),
        lateralOffset: q(0, 'px', basis),
        peakIntensity: q(peak.intensity, 'pixel-intensity', basis),
        width: q(peak.fwhm, 'px', basis),
        flatTop: peak.flatTop,
        saturated: peak.saturated,
        smeared: peak.smeared,
        overlapsWith,
      });
      if (peak.saturated) {
        diagnostics.push({
          code: 'SATURATED_BAND',
          severity: 'warning',
          message: `车道 ${lane.label} 弧长 ${peak.s.toFixed(1)}px 处条带达到饱和，只能给区间`,
          at: { objectId: bandId, laneId: lane.laneId, point: center },
        });
      }
      if (peak.smeared) {
        diagnostics.push({
          code: 'SMEARED_BAND',
          severity: 'warning',
          message: `车道 ${lane.label} 的条带拖尾（不对称比 ${peak.tailRatio.toFixed(2)}），只能标候选`,
          at: { objectId: bandId, laneId: lane.laneId },
        });
      }
    }
  }
  return { bands, diagnostics };
}

interface BandProfileExt {
  neighborIndexes?: number[];
}
