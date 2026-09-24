/** 分子量校准：局部标尺 + 有效区域 + 插值段。
 *  核心规则：
 *  - "微笑"弯曲使同一高度不等于同一分子量 → 每条泳道用局部标尺，标尺必须带有效区域；
 *  - 饱和条带、拖尾和重叠只能标为候选或区间；
 *  - 非单调标尺 → 语义无解，带位置诊断；
 *  - 无法唯一决定时保留全部合法候选。 */
import type {
  BandCenter, Diagnostic, Interval, LadderNominal, LocalRuler, MwEstimate, Quantity, Result,
} from "./types";
import { ok, fail } from "./types";

export const CALIBRATION_VERSION = "calib-v1";

export interface RulerInput {
  laneIndex: number;
  nominals: LadderNominal[];          // 标称值（含像素级指派）
  /** 该标尺覆盖的泳道范围（局部标尺的有效区域） */
  validLanes: [number, number];
  /** 图像 y 方向有效范围（px） */
  imageHeight: number;
}

/** 构建局部标尺：检查单调性，给出有效区域 */
export function buildRuler(input: RulerInput): Result<LocalRuler> {
  const diagnostics: Diagnostic[] = [];
  const anchors = input.nominals
    .filter((n) => n.assignedCenter !== undefined)
    .map((n) => ({
      yPx: n.assignedCenter!.y,
      logSize: Math.log10(n.size.value),
      sizeRaw: n.size.raw ?? `${n.size.value} ${n.size.unit}`,
      size: n.size,
    }))
    .sort((a, b) => a.yPx - b.yPx);
  if (anchors.length < 2) {
    return fail("semantic-unsolvable", [{
      code: "RULER_TOO_FEW_ANCHORS",
      message: `泳道 ${input.laneIndex} 的标尺锚点不足（${anchors.length} < 2），无法插值`,
      location: `lane:${input.laneIndex}`,
      severity: "error",
    }]);
  }
  // 迁移距离越大（y 越大）分子量应越小 → logSize 必须随 y 单调递减
  let monotonic = true;
  for (let i = 1; i < anchors.length; i++) {
    if (!(anchors[i].logSize < anchors[i - 1].logSize)) {
      monotonic = false;
      diagnostics.push({
        code: "RULER_NON_MONOTONIC",
        message: `泳道 ${input.laneIndex} 标尺非单调：y=${anchors[i - 1].yPx.toFixed(1)} (${anchors[i - 1].sizeRaw}) 与 y=${anchors[i].yPx.toFixed(1)} (${anchors[i].sizeRaw}) 违反迁移方向`,
        location: `lane:${input.laneIndex}/anchor:${i}`,
        severity: "error",
      });
    }
  }
  if (!monotonic) return fail("semantic-unsolvable", diagnostics);
  const yLo = anchors[0].yPx;
  const yHi = anchors[anchors.length - 1].yPx;
  return ok({
    laneIndex: input.laneIndex,
    anchors: anchors.map((a) => ({ yPx: a.yPx, logSize: a.logSize, sizeRaw: a.sizeRaw })),
    validLanes: input.validLanes,
    validY: [yLo, yHi],
    monotonic: true,
  }, diagnostics);
}

/** 插值段查询：返回 y 所在的相邻锚点对；超出范围返回 undefined */
export function findSegment(ruler: LocalRuler, yPx: number):
  { loY: number; hiY: number; loSize: string; hiSize: string; loLog: number; hiLog: number } | undefined {
  const a = ruler.anchors;
  for (let i = 1; i < a.length; i++) {
    if (yPx >= a[i - 1].yPx && yPx <= a[i].yPx) {
      return {
        loY: a[i - 1].yPx, hiY: a[i].yPx,
        loSize: a[i - 1].sizeRaw, hiSize: a[i].sizeRaw,
        loLog: a[i - 1].logSize, hiLog: a[i].logSize,
      };
    }
  }
  return undefined;
}

export interface SmileModel {
  /** 每条泳道的 y 偏移（相对标尺泳道），由共同条带/对齐标记估计；无则为 0 */
  laneYOffset: Map<number, number>;
}

/** 在泳道 laneIndex 上估计 yPx 处条带的分子量。
 *  smile 校正：yEffective = yPx - laneYOffset(lane) */
export function estimateMw(
  ruler: LocalRuler,
  band: BandCenter,
  smile: SmileModel,
): MwEstimate {
  if (band.laneIndex < ruler.validLanes[0] || band.laneIndex > ruler.validLanes[1]) {
    return {
      kind: "unavailable",
      reason: `泳道 ${band.laneIndex} 在标尺泳道 ${ruler.laneIndex} 的有效区域 [${ruler.validLanes[0]}, ${ruler.validLanes[1]}] 之外`,
      rulerLane: ruler.laneIndex,
    };
  }
  const yOffset = smile.laneYOffset.get(band.laneIndex) ?? 0;
  const yEff = band.center.y - yOffset;
  const seg = findSegment(ruler, yEff);
  if (!seg) {
    return {
      kind: "unavailable",
      reason: `y=${yEff.toFixed(1)}px 超出标尺有效区间 [${ruler.validY[0].toFixed(1)}, ${ruler.validY[1].toFixed(1)}]px，不允许外推`,
      rulerLane: ruler.laneIndex,
    };
  }
  const t = (yEff - seg.loY) / Math.max(1e-9, seg.hiY - seg.loY);
  const logSize = seg.loLog + t * (seg.hiLog - seg.loLog);
  const unit = ruler.anchors.length > 0 && ruler.anchors[0].sizeRaw.toLowerCase().includes("kda") ? "kDa" : "bp";
  const size: Quantity = { value: Math.pow(10, logSize), unit: unit as Quantity["unit"] };
  const segment = { loY: seg.loY, hiY: seg.hiY, loSize: seg.loSize, hiSize: seg.hiSize };
  // 饱和/拖尾 → 只能给区间；重叠 → 只能给候选
  if (band.flags.includes("saturated") || band.flags.includes("smearing")) {
    const halfLog = Math.abs(seg.hiLog - seg.loLog) * (band.halfWidthPx / Math.max(1e-9, seg.hiY - seg.loY));
    const interval: Interval = {
      lo: Math.pow(10, logSize - halfLog),
      hi: Math.pow(10, logSize + halfLog),
      unit: size.unit,
    };
    return { kind: "interval", interval, rulerLane: ruler.laneIndex, segment };
  }
  if (band.flags.includes("overlap")) {
    // 无法唯一决定：保留全部合法候选（峰中心 ± 半高宽处的三个合法解）
    const candidates: Quantity[] = [-1, 0, 1].map((k) => {
      const y = yEff + k * band.halfWidthPx * 0.5;
      const s2 = findSegment(ruler, Math.min(Math.max(y, ruler.validY[0]), ruler.validY[1]));
      if (!s2) return size;
      const t2 = (Math.min(Math.max(y, ruler.validY[0]), ruler.validY[1]) - s2.loY) / Math.max(1e-9, s2.hiY - s2.loY);
      return { value: Math.pow(10, s2.loLog + t2 * (s2.hiLog - s2.loLog)), unit: size.unit };
    });
    return { kind: "candidates", candidates, rulerLane: ruler.laneIndex, segment };
  }
  return { kind: "point", value: size, rulerLane: ruler.laneIndex, segment };
}

/** 拟合残差：对标尺锚点做最小二乘线性拟合（log10(size) ~ y），返回各锚点残差 */
export function rulerResiduals(ruler: LocalRuler): { yPx: number; sizeRaw: string; residualLog: number }[] {
  const a = ruler.anchors;
  const n = a.length;
  const sx = a.reduce((s, p) => s + p.yPx, 0);
  const sy = a.reduce((s, p) => s + p.logSize, 0);
  const sxx = a.reduce((s, p) => s + p.yPx * p.yPx, 0);
  const sxy = a.reduce((s, p) => s + p.yPx * p.logSize, 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return a.map((p) => ({
    yPx: p.yPx,
    sizeRaw: p.sizeRaw,
    residualLog: p.logSize - (slope * p.yPx + intercept),
  }));
}

/** ladder 缺带检测：标称值数目与已指派锚点数不一致 */
export function ladderMissingBands(nominals: LadderNominal[]): Diagnostic[] {
  const missing = nominals.filter((n) => n.assignedCenter === undefined);
  return missing.map((n) => ({
    code: "LADDER_BAND_MISSING",
    message: `ladder 标称值 ${n.size.raw ?? n.size.value} 未指派到图像条带（缺带），该锚点不参与标尺`,
    location: `ladder/band:${n.bandIndex}`,
    severity: "warning",
  }));
}
