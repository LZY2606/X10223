/**
 * 自动候选检测：沿泳道曲线扫描灰度剖面，找出条带中心。
 * 饱和（削顶）、拖尾、重叠只产出候选或区间，绝不伪造唯一点估计。
 */
import { decodeGrayPng } from "../shared/png";
import { GEL_TOP, laneCenterX, smileScale } from "../casepack/gel";

export interface DetectedBand {
  lane: number;
  /** 迁移距离 s（px, derived），饱和/重叠时为中点估计。 */
  s: number;
  sInterval?: { lo: number; hi: number };
  peakIntensity: number;
  saturated: boolean;
  overlapped: boolean;
  trailing: boolean;
  /** 像素级来源（raw 坐标）。 */
  rawX: number;
  rawY: number;
}

export interface LaneProfile {
  lane: number;
  /** 沿泳道的采样点：s（迁移距离 px）与强度。 */
  samples: Array<{ s: number; y: number; x: number; intensity: number }>;
}

export function laneProfile(
  png: Buffer,
  lane: number,
  opts: { bendPx: number; smile: number; step?: number },
): LaneProfile {
  const { pixels, width, height } = decodeGrayPng(png);
  const step = opts.step ?? 1;
  const scale = smileScale(lane, opts.smile);
  const samples: LaneProfile["samples"] = [];
  for (let y = GEL_TOP + 4; y < Math.min(height, GEL_TOP + 600); y += step) {
    const cx = Math.round(laneCenterX(lane, y, opts.bendPx));
    // 横向取 5px 平均，降低噪声
    let sum = 0;
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      if (x >= 0 && x < width) {
        sum += pixels[y * width + x];
        n++;
      }
    }
    samples.push({ s: (y - GEL_TOP) / scale, y, x: cx, intensity: n ? sum / n : 0 });
  }
  return { lane, samples };
}

const SATURATION_LEVEL = 254;
const PEAK_THRESHOLD = 60; // 背景约 18
const VALLEY_RATIO = 0.55; // 峰间谷值低于该比例视为可分

export function detectBands(profile: LaneProfile): DetectedBand[] {
  const out: DetectedBand[] = [];
  const samples = profile.samples;
  const isPeak = (i: number) =>
    samples[i].intensity >= PEAK_THRESHOLD &&
    samples[i].intensity >= samples[i - 1]?.intensity &&
    samples[i].intensity > samples[i + 1]?.intensity;

  for (let i = 1; i < samples.length - 1; i++) {
    if (!isPeak(i)) continue;
    const peak = samples[i];
    // 饱和检测：峰顶平台达到饱和电平。
    let flatTop = 0;
    for (let j = i; j < samples.length && samples[j].intensity >= SATURATION_LEVEL; j++) flatTop++;
    for (let j = i; j >= 0 && samples[j].intensity >= SATURATION_LEVEL; j--) flatTop++;
    const saturated = peak.intensity >= SATURATION_LEVEL && flatTop >= 3;

    // 半高宽 → 位置区间与拖尾检测。
    const half = Math.max(PEAK_THRESHOLD, peak.intensity / 2);
    let loIdx = i;
    while (loIdx > 0 && samples[loIdx].intensity > half) loIdx--;
    let hiIdx = i;
    while (hiIdx < samples.length - 1 && samples[hiIdx].intensity > half) hiIdx++;
    const widthPx = samples[hiIdx].s - samples[loIdx].s;
    const trailing = widthPx > 26 && !saturated;

    // 重叠检测：与前一峰之间谷值不够深。
    const prev = out[out.length - 1];
    const overlapped =
      prev !== undefined &&
      (() => {
        const prevIdx = samples.findIndex((sm) => sm.s >= prev.s);
        if (prevIdx < 0 || prevIdx >= i) return false;
        let valley = Infinity;
        for (let j = prevIdx; j <= i; j++) valley = Math.min(valley, samples[j].intensity);
        const shallower = Math.min(prev.peakIntensity, peak.intensity);
        return i - prevIdx < 24 && valley > shallower * VALLEY_RATIO;
      })();

    const band: DetectedBand = {
      lane: profile.lane,
      s: peak.s,
      peakIntensity: peak.intensity,
      saturated,
      overlapped,
      trailing,
      rawX: peak.x,
      rawY: peak.y,
    };
    if (saturated || overlapped || trailing) {
      band.sInterval = { lo: samples[loIdx].s, hi: samples[hiIdx].s };
      if (overlapped && prev && !prev.sInterval) {
        prev.sInterval = { lo: prev.s - 4, hi: prev.s + 4 };
        prev.overlapped = true;
      }
    }
    out.push(band);
  }
  return out;
}
