import { diag, type Diagnostic } from './units';

/** Deterministic band detection on a normalized grayscale image along lane centerlines. */

export interface DetectParams {
  thresholdGray: number;
  minPeakGray: number;
  saturationGray: number;
  smearAsymmetry: number;
  overlapMinSeparationPx: number;
}

export const DEFAULT_DETECT_PARAMS: DetectParams = {
  thresholdGray: 40,
  minPeakGray: 60,
  saturationGray: 255,
  smearAsymmetry: 1.8,
  overlapMinSeparationPx: 3,
};

export interface DetectedBand {
  bandKey: string;
  laneId: string;
  xPx: number;
  yPx: number;
  peak: number;
  widthPx: number;
  upWidthPx: number;
  downWidthPx: number;
  flags: string[];
  overlapGroup?: string;
}

export interface CenterlinePoint {
  x: number;
  y: number;
}

function sampleProfile(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerline: CenterlinePoint[],
): { ys: number[]; xs: number[]; profile: Float64Array } {
  const n = centerline.length;
  const profile = new Float64Array(n);
  const ys: number[] = new Array(n);
  const xs: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const cx = Math.round(centerline[i].x);
    const cy = Math.round(centerline[i].y);
    ys[i] = cy;
    xs[i] = cx;
    let sum = 0;
    let cnt = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      if (x >= 0 && x < width && cy >= 0 && cy < height) {
        sum += pixels[cy * width + x];
        cnt++;
      }
    }
    profile[i] = cnt ? sum / cnt : 0;
  }
  return { ys, xs, profile };
}

export function detectBands(
  img: { width: number; height: number; pixels: Uint8Array },
  laneId: string,
  centerline: CenterlinePoint[],
  params: DetectParams = DEFAULT_DETECT_PARAMS,
): { bands: DetectedBand[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const { ys, xs, profile } = sampleProfile(img.pixels, img.width, img.height, centerline);
  const bands: DetectedBand[] = [];
  let i = 0;
  let regionIdx = 0;
  while (i < profile.length) {
    if (profile[i] < params.thresholdGray) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < profile.length && profile[j + 1] >= params.thresholdGray) j++;
    // local maxima inside region [i, j]
    const maxima: number[] = [];
    for (let k = i; k <= j; k++) {
      const left = k > i ? profile[k - 1] : -1;
      const right = k < j ? profile[k + 1] : -1;
      if (profile[k] >= left && profile[k] >= right && profile[k] >= params.minPeakGray) {
        if (maxima.length === 0 || k - maxima[maxima.length - 1] >= params.overlapMinSeparationPx) {
          maxima.push(k);
        } else if (profile[k] > profile[maxima[maxima.length - 1]]) {
          maxima[maxima.length - 1] = k;
        }
      }
    }
    const overlap = maxima.length > 1;
    const groupId = overlap ? `${laneId}#ov${regionIdx}` : undefined;
    if (overlap) {
      diagnostics.push(
        diag('overlap-candidate', `两条带重叠：区域 ${ys[i]}–${ys[j]}px 内检出 ${maxima.length} 个峰，仅作候选`, 'warning', {
          lane: laneId,
          yPx: ys[Math.floor((i + j) / 2)],
        }),
      );
    }
    for (const m of maxima) {
      const peak = profile[m];
      const half = params.thresholdGray + (peak - params.thresholdGray) / 2;
      let up = m;
      while (up > i && profile[up - 1] >= half) up--;
      let down = m;
      while (down < j && profile[down + 1] >= half) down++;
      const upWidthPx = ys[m] - ys[up];
      const downWidthPx = ys[down] - ys[m];
      const flags: string[] = [];
      if (peak >= params.saturationGray) {
        flags.push('saturated');
        diagnostics.push(
          diag('saturated-band', `饱和条带：峰值 ${peak.toFixed(0)} 达到饱和灰度，中心可能偏移，仅可作区间`, 'warning', {
            lane: laneId,
            yPx: ys[m],
          }),
        );
      }
      if (upWidthPx > 0 && downWidthPx / upWidthPx >= params.smearAsymmetry) {
        flags.push('smear');
        diagnostics.push(
          diag('smear-tail', `拖尾条带：下半宽 ${downWidthPx}px / 上半宽 ${upWidthPx}px 不对称，仅可作区间`, 'warning', {
            lane: laneId,
            yPx: ys[m],
          }),
        );
      }
      if (overlap) flags.push('overlap');
      const band: DetectedBand = {
        bandKey: `${laneId}#b${bands.length}`,
        laneId,
        xPx: xs[m],
        yPx: ys[m],
        peak,
        widthPx: ys[down] - ys[up],
        upWidthPx,
        downWidthPx,
        flags,
      };
      if (groupId) band.overlapGroup = groupId;
      bands.push(band);
    }
    regionIdx++;
    i = j + 1;
  }
  return { bands, diagnostics };
}
