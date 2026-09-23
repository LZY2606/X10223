import {
  buildPolyline,
  centerline,
  orientPoint,
  orientPolyline,
  orientedSize,
  pointAtS,
  projectToPolyline,
  type PolylineGeom,
} from "./geometry.js";
import { stableId } from "./hash.js";
import {
  KERNEL_VERSION,
  type AutoBand,
  type BandStatus,
  type ComputeContext,
  type InputDigest,
  type ProfilePoint,
} from "./kernel-types.js";
import type {
  BandCenter,
  BudgetExhaustedError as _B,
  ImageMaterial,
  LaneBoundary,
  OrientationMaterial,
  PxPoint,
} from "./types.js";
import { BudgetExhaustedError } from "./types.js";
import type { GrayImage } from "./png.js";

/** 按拍摄方向从原始图像采样（双线性），返回灰度强度 0..255 */
export function orientedSample(img: GrayImage, o: OrientationMaterial["orientation"], p: PxPoint): number {
  const { w: W, h: H } = orientedSize(img.width, img.height, o);
  // 将审阅坐标反变换回原始坐标
  let x: number;
  let y: number;
  if (o === "up") {
    x = p.x;
    y = p.y;
  } else if (o === "right") {
    x = p.y;
    y = H - 1 - p.x;
  } else if (o === "down") {
    x = W - 1 - p.x;
    y = H - 1 - p.y;
  } else {
    x = W - 1 - p.y;
    y = p.x;
  }
  const bilinear = (fx: number, fy: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(img.width - 1, x0 + 1);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (xx: number, yy: number): number => {
      if (img.channels === 1) return img.data[yy * img.width + xx]!;
      const i = (yy * img.width + xx) * 3;
      return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    };
    return (
      at(x0, y0) * (1 - tx) * (1 - ty) +
      at(x1, y0) * tx * (1 - ty) +
      at(x0, y1) * (1 - tx) * ty +
      at(x1, y1) * tx * ty
    );
  };
  return bilinear(Math.max(0, Math.min(img.width - 1, x)), Math.max(0, Math.min(img.height - 1, y)));
}

export interface LaneGeoms {
  lane: LaneBoundary;
  center: PolylineGeom;
  left: PolylineGeom;
  right: PolylineGeom;
  halfWidthAt(s: number): number;
}

export function buildLaneGeoms(lane: LaneBoundary, img: ImageMaterial, orientation: OrientationMaterial["orientation"]): LaneGeoms {
  const cl = orientPolyline(centerline(lane.left, lane.right), orientation, img.width, img.height);
  const left = orientPolyline(lane.left, orientation, img.width, img.height);
  const right = orientPolyline(lane.right, orientation, img.width, img.height);
  const center = buildPolyline(cl.pts);
  const leftG = buildPolyline(left.pts);
  const rightG = buildPolyline(right.pts);
  return {
    lane,
    center,
    left: leftG,
    right: rightG,
    halfWidthAt(s: number): number {
      const c = pointAtS(center, s);
      return (
        (Math.abs(projectToPolyline(leftG, c).d) + Math.abs(projectToPolyline(rightG, c).d)) / 2
      );
    },
  };
}

/**
 * 沿泳道中线采样剖面。亮带 → 高强度。
 * 采样点数受预算限制；超限返回 BudgetExhaustedError（资源耗尽是独立结果）。
 */
export function sampleProfile(
  img: GrayImage,
  orientation: OrientationMaterial["orientation"],
  geoms: LaneGeoms,
  ctx: ComputeContext,
  saturationLevel: number,
): ProfilePoint[] {
  const total = geoms.center.totalLength;
  const step = 1;
  const n = Math.floor(total / step) + 1;
  if (n > ctx.opts.maxSamplesPerLane) {
    throw new BudgetExhaustedError(
      `泳道 ${geoms.lane.laneId} 采样点数 ${n} 超过预算 ${ctx.opts.maxSamplesPerLane}`,
      { kind: "samplesPerLane", limit: ctx.opts.maxSamplesPerLane, used: n },
    );
  }
  const out: ProfilePoint[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.min(total, i * step);
    const at = pointAtS(geoms.center, s);
    const half = Math.max(2, Math.min(geoms.halfWidthAt(s), ctx.detect.halfWidthPx));
    let sum = 0;
    let count = 0;
    let saturated = false;
    // 法向：用中线在 s 处的切向旋转 90° 取横截线
    const eps = 0.5;
    const pA = pointAtS(geoms.center, Math.max(0, s - eps));
    const pB = pointAtS(geoms.center, Math.min(total, s + eps));
    let tx = pB.x - pA.x;
    let ty = pB.y - pA.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    for (let off = -half; off <= half; off += 1) {
      const v = orientedSample(img, orientation, { x: at.x + nx * off, y: at.y + ny * off });
      sum += v;
      count++;
      if (v >= saturationLevel) saturated = true;
    }
    out.push({ s, at, intensity: sum / count, saturated });
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stddev(values: number[], mean: number): number {
  const v = values.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, values.length);
  return Math.sqrt(v);
}

export interface RawPeak {
  index: number;
  s: number;
  at: PxPoint;
  intensity: number;
  fwhm: number;
  tailAsymmetry: number;
  saturated: boolean;
}

/** 在剖面上找峰并估算 FWHM / 拖尾不对称度 */
export function findPeaks(profile: ProfilePoint[], ctx: ComputeContext): RawPeak[] {
  if (profile.length < 3) return [];
  const values = profile.map((p) => p.intensity);
  const baseline = median(values);
  const noise = Math.max(1, stddev(values.filter((v) => v < baseline + 5), baseline));
  const threshold = baseline + ctx.detect.zThreshold * noise;
  const halfWin = Math.max(1, Math.round(ctx.detect.peakWindowPx / 2));

  const peaks: RawPeak[] = [];
  for (let i = halfWin; i < profile.length - halfWin; i++) {
    const v = profile[i]!.intensity;
    if (v < threshold) continue;
    let isMax = true;
    for (let j = i - halfWin; j <= i + halfWin; j++) {
      if (j !== i && profile[j]!.intensity > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    // 抑制同窗口重复峰：要求与上一个峰距离 >= halfWin
    if (peaks.length && i - peaks[peaks.length - 1]!.index < halfWin) {
      if (v > profile[peaks[peaks.length - 1]!.index]!.intensity) peaks[peaks.length - 1]!.index = i;
      continue;
    }
    peaks.push({ index: i, s: profile[i]!.s, at: profile[i]!.at, intensity: v, fwhm: 0, tailAsymmetry: 0, saturated: profile[i]!.saturated });
  }

  for (const pk of peaks) {
    const half = (pk.intensity + baseline) / 2;
    let lo = pk.index;
    let hi = pk.index;
    while (lo > 0 && profile[lo]!.intensity > half) lo--;
    while (hi < profile.length - 1 && profile[hi]!.intensity > half) hi++;
    pk.fwhm = Math.max(1, (hi - lo));
    // 拖尾不对称：峰下半高两侧宽度之比（迁移方向尾部更长）
    let tailLo = pk.index;
    let tailHi = pk.index;
    const low = baseline + (pk.intensity - baseline) * 0.25;
    while (tailLo > 0 && profile[tailLo]!.intensity > low) tailLo--;
    while (tailHi < profile.length - 1 && profile[tailHi]!.intensity > low) tailHi++;
    const upLen = pk.index - tailLo;
    const downLen = tailHi - pk.index;
    pk.tailAsymmetry = downLen / Math.max(1, upLen);
    // 任一 FWHM 内采样点饱和 → 条带饱和
    for (let j = lo; j <= hi; j++) if (profile[j]!.saturated) pk.saturated = true;
  }
  return peaks;
}

function classify(peaks: RawPeak[]): { status: BandStatus; overlaps: Record<number, number[]> } {
  const overlaps: Record<number, number[]> = {};
  // 重叠：FWHM 区间相交（两条带重叠 → 只能候选/区间）
  for (let i = 0; i < peaks.length; i++) {
    overlaps[i] = [];
    const pi = peaks[i]!;
    for (let j = 0; j < peaks.length; j++) {
      if (i === j) continue;
      const pj = peaks[j]!;
      const iLo = pi.s - pi.fwhm / 2;
      const iHi = pi.s + pi.fwhm / 2;
      const jLo = pj.s - pj.fwhm / 2;
      const jHi = pj.s + pj.fwhm / 2;
      if (iLo < jHi && jLo < iHi) overlaps[i]!.push(j);
    }
  }
  return { status: "ok", overlaps };
}

export interface DetectLaneResult {
  bands: AutoBand[];
  profile: ProfilePoint[];
}

export function detectLane(
  img: GrayImage,
  orientation: OrientationMaterial["orientation"],
  geoms: LaneGeoms,
  manualBands: BandCenter[],
  saturationLevel: number,
  ctx: ComputeContext,
  digest: InputDigest,
  detectParamId: string,
): DetectLaneResult {
  const profile = sampleProfile(img, orientation, geoms, ctx, saturationLevel);
  const peaks = findPeaks(profile, ctx);
  const { overlaps } = classify(peaks);

  // 人工条带中心投影到同一中线，用于自动候选 ↔ 人工来源对比
  const manualProj = manualBands
    .filter((b) => b.laneId === geoms.lane.laneId)
    .map((b) => {
      const op = orientPoint(b.at, orientation, img.width, img.height);
      const pr = projectToPolyline(geoms.center, op);
      return { id: b.id, s: pr.s };
    });

  const bands: AutoBand[] = peaks.map((pk, i) => {
    const overlapIdx = overlaps[i]!;
    const tailed = pk.tailAsymmetry >= 1.8;
    const saturated = pk.saturated;
    const overlapped = overlapIdx.length > 0;
    const status: BandStatus =
      saturated && tailed
        ? "saturated+tailed"
        : saturated && overlapped
          ? "saturated+overlapped"
          : saturated
            ? "saturated"
            : tailed
              ? "tailed"
              : overlapped
                ? "overlapped"
                : "ok";
    const matched =
      manualProj
        .map((m) => ({ id: m.id, d: Math.abs(m.s - pk.s) }))
        .filter((m) => m.d <= Math.max(4, pk.fwhm))
        .sort((a, b) => a.d - b.d)[0]?.id ?? null;

    const idBase = {
      laneId: geoms.lane.laneId,
      s: Math.round(pk.s * 100) / 100,
      digest,
      paramVersion: detectParamId,
      kernel: KERNEL_VERSION,
    };
    const parentIds = [geoms.lane.id, detectParamId, digest.imageSha ?? "no-image"].filter(Boolean);
    return {
      kind: "autoBand",
      id: stableId("band", idBase),
      laneId: geoms.lane.laneId,
      peakS: pk.s,
      peakAt: pk.at,
      fwhm: pk.fwhm,
      tailAsymmetry: Math.round(pk.tailAsymmetry * 100) / 100,
      status,
      peakIntensity: Math.round(pk.intensity * 10) / 10,
      overlapsWith: [],
      matchedManualBandId: matched,
      inputDigest: digest,
      paramVersion: detectParamId,
      kernelVersion: KERNEL_VERSION,
      parentIds,
    };
  });

  // 填充重叠对象的稳定 id
  bands.forEach((b, i) => {
    b.overlapsWith = overlaps[i]!.map((j) => bands[j]!.id);
  });
  return { bands, profile };
}
