import { PNG } from 'pngjs';
import type {
  BandCenterMaterial,
  Diagnostic,
  ExposureMaterial,
  ImageMaterial,
  InputSummary,
  LaneTraceMaterial,
  Material,
} from './types';
import { contentId, derivedId } from './ids';
import { pointAtArcLength, polylineLength, projectionArcLength } from './geometry';
import type { CalcParams } from './params';

export interface DetectedPeak {
  s: number;
  center: { x: number; y: number };
  widthPx: number;
  prominence: number;
  saturated: boolean;
  tailing: boolean;
  profile: { s: number; intensity: number }[];
}

/** 解码灰度 PNG（支持 8/16 位），返回归一化 0..1 浮点场与编码上限 */
export function decodeGrayPng(buffer: Buffer): { data: Float32Array; width: number; height: number; maxEncoded: number } {
  const png = PNG.sync.read(buffer);
  const bit16 = png.data.length === png.width * png.height * 2;
  const channels = png.data.length / (png.width * png.height);
  const maxEncoded = bit16 ? 65535 : 255;
  const data = new Float32Array(png.width * png.height);
  for (let i = 0; i < png.width * png.height; i++) {
    let g: number;
    if (bit16) g = (png.data[i * 2]! << 8) | png.data[i * 2 + 1]!;
    else g = png.data[i * channels]!;
    data[i] = g / maxEncoded;
  }
  return { data, width: png.width, height: png.height, maxEncoded };
}

/** 沿 lane 中心线按弧长采样强度（横向取 lane 宽度内均值），返回轮廓 */
export function sampleProfile(
  data: Float32Array,
  width: number,
  height: number,
  lane: LaneTraceMaterial,
  halfWidth: number,
  stepPx = 1
): { s: number; intensity: number }[] {
  const total = polylineLength(lane.centerline);
  const out: { s: number; intensity: number }[] = [];
  for (let s = 0; s <= total; s += stepPx) {
    const p = pointAtArcLength(lane.centerline, s);
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx += 2) {
      const x = Math.round(p.x + dx);
      const y = Math.round(p.y);
      if (x >= 0 && x < width && y >= 0 && y < height) {
        sum += data[y * width + x]!;
        n++;
      }
    }
    out.push({ s, intensity: n ? sum / n : 0 });
  }
  return out;
}

/** 简单峰检测：局部极大 + 相对谷底 prominence */
export function detectPeaks(
  profile: { s: number; intensity: number }[],
  params: CalcParams,
  clipRatio: number
): DetectedPeak[] {
  const peaks: DetectedPeak[] = [];
  const intensities = profile.map((p) => p.intensity);
  for (let i = 2; i < profile.length - 2; i++) {
    const v = intensities[i]!;
    if (
      v > intensities[i - 1]! &&
      v >= intensities[i + 1]! &&
      v > intensities[i - 2]! &&
      v > intensities[i + 2]!
    ) {
      let left = i;
      while (left > 0 && intensities[left - 1]! < v) left--;
      let right = i;
      while (right < intensities.length - 1 && intensities[right + 1]! < v) right++;
      const base = Math.min(intensities[left]!, intensities[right]!);
      const prominence = v - base;
      if (prominence < params.minBandProminence) continue;
      const widthPx = Math.max(3, (right - left) / 2);
      // 拖尾：峰两侧面积显著不对称（迁移向下=更大 s 一侧）
      let areaLo = 0;
      let areaHi = 0;
      for (let j = left; j < i; j++) areaLo += intensities[j]! - base;
      for (let j = i + 1; j <= right; j++) areaHi += intensities[j]! - base;
      const tailing = areaHi > areaLo * params.tailingAsymmetry;
      peaks.push({
        s: profile[i]!.s,
        center: { x: 0, y: 0 },
        widthPx,
        prominence,
        saturated: v >= clipRatio,
        tailing,
        profile: profile.slice(left, right + 1),
      });
    }
  }
  return peaks;
}

export interface DetectionOutput {
  record: {
    id: string;
    kind: 'detection';
    subjectId: string;
    state: 'ok' | 'candidate_set';
    value: { peakArcLengths: number[]; bandIds: string[] };
    diagnostics: Diagnostic[];
    parentDerivedIds: string[];
  };
  bands: BandCenterMaterial[];
}

/**
 * 自动检测某 lane 的条带候选。输入不完整时返回带位置的诊断，
 * 绝不用空值/默认值伪装成功。
 */
export function detectLaneBands(
  image: ImageMaterial,
  pngBuffer: Buffer,
  exposure: ExposureMaterial | undefined,
  lane: LaneTraceMaterial,
  params: CalcParams,
  inputSummary: InputSummary,
  logicalClock: number,
  halfWidth = 8
): DetectionOutput | { diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!pngBuffer || pngBuffer.length === 0) {
    return {
      diagnostics: [
        {
          code: 'INCOMPLETE_INPUT',
          severity: 'error',
          message: '原始图像字节缺失，无法检测条带',
          location: { materialId: image.id, jsonPath: 'blobSha256' },
        },
      ],
    };
  }
  if (!exposure) {
    diagnostics.push({
      code: 'INCOMPLETE_INPUT',
      severity: 'error',
      message: '缺少曝光/编码上限材料，饱和判定无基准',
      location: { laneId: lane.id, jsonPath: 'exposure' },
    });
    return { diagnostics };
  }
  if (lane.centerline.length < 2) {
    return {
      diagnostics: [
        {
          code: 'INCOMPLETE_INPUT',
          severity: 'error',
          message: 'lane 中心线点数不足，无法定义迁移轴',
          location: { laneId: lane.id, jsonPath: 'centerline' },
        },
      ],
    };
  }

  const { data, width, height } = decodeGrayPng(pngBuffer);
  const clipRatio = params.saturationClip;
  const profile = sampleProfile(data, width, height, lane, halfWidth);
  const peaks = detectPeaks(profile, params, clipRatio);

  const bands: BandCenterMaterial[] = peaks.map((peak, idx) => {
    const center = pointAtArcLength(lane.centerline, peak.s);
    const id = contentId('band', {
      lane: lane.id,
      frame: lane.frameId,
      s: round6(peak.s),
      w: peak.widthPx,
      auto: true,
    });
    // 重叠：相邻峰中心弧距低于阈值
    let overlapWith: string | undefined;
    if (idx > 0) {
      const prev = peaks[idx - 1]!;
      if (Math.abs(peak.s - prev.s) < params.overlapCenterDistancePx) {
        const prevId = contentId('band', {
          lane: lane.id,
          frame: lane.frameId,
          s: round6(prev.s),
          w: prev.widthPx,
          auto: true,
        });
        overlapWith = prevId;
      }
    }
    const band: BandCenterMaterial = {
      id,
      projectId: lane.projectId,
      type: 'band_center',
      laneId: lane.id,
      frameId: lane.frameId,
      center,
      profile: peak.profile.map((p) => ({ s: round3(p.s), intensity: round4(p.intensity) })),
      widthPx: round3(peak.widthPx),
      saturated: peak.saturated,
      tailing: peak.tailing,
      overlapWith,
      status: 'auto_candidate',
      author: 'auto',
      raw: {
        detector: 'profile-peak-v1',
        peakIntensity: round4(profile[Math.round(peak.s)]?.intensity ?? peak.prominence),
        clipRatio,
      },
      provenance: {
        center: `image#${image.id}|lane#${lane.id}|arcLength`,
        profile: `image#${image.id}|lane#${lane.id}|profile`,
        saturated: `exposure#${exposure.id}|maxEncoded`,
      },
      importedAs: 'px+uint16-ratio',
      createdAtLogical: logicalClock,
    };
    return band;
  });

  // 重叠双向标注
  for (const b of bands) {
    if (b.overlapWith) {
      const other = bands.find((x) => x.id === b.overlapWith);
      if (other && !other.overlapWith) other.overlapWith = b.id;
    }
  }

  for (const band of bands) {
    if (band.saturated) {
      diagnostics.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        message: '条带中心触顶，位置仅能作为候选/区间',
        location: { bandId: band.id, laneId: lane.id, at: band.center },
      });
    }
    if (band.tailing) {
      diagnostics.push({
        code: 'TAILING_BAND',
        severity: 'warning',
        message: '条带拖尾，中心不可唯一确定，保留候选/区间',
        location: { bandId: band.id, laneId: lane.id, at: band.center },
      });
    }
    if (band.overlapWith) {
      diagnostics.push({
        code: 'OVERLAPPING_BANDS',
        severity: 'warning',
        message: '两条带中心距过近发生重叠，只能给区间',
        location: { bandId: band.id, laneId: lane.id, at: band.center },
      });
    }
  }

  const recordId = derivedId('detection', {
    image: image.id,
    lane: lane.id,
    exposure: exposure.id,
    params: params.version,
    peaks: bands.map((b) => [round6(arcOf(b, lane)), b.widthPx]),
  });

  return {
    record: {
      id: recordId,
      kind: 'detection' as const,
      subjectId: lane.id,
      state: bands.some((b) => b.saturated || b.tailing || b.overlapWith) ? ('candidate_set' as const) : ('ok' as const),
      value: { peakArcLengths: bands.map((b) => round6(arcOf(b, lane))), bandIds: bands.map((b) => b.id) },
      diagnostics,
      parentDerivedIds: [],
    },
    bands,
  };
}

function arcOf(band: BandCenterMaterial, lane: LaneTraceMaterial): number {
  return projectionArcLength(lane.centerline, band.center).s;
}

function round3(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function summarizeMaterials(materials: Material[]): InputSummary['materialHashes'] {
  const map: Record<string, string> = {};
  for (const m of materials) map[m.id] = contentId('hash', { id: m.id, raw: m.raw }).replace(/^hash_/, '');
  return map;
}
