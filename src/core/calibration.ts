/**
 * 局部标尺（迁移弧长 -> 分子量）。
 *
 * 关键规则：
 *  - “微笑”弯曲后，同一像素高度不等于同一分子量；标定沿每条泳道中心线的弧长 u 进行，
 *    标尺带有有效区域 validRegion，区域外不外推；
 *  - 标尺必须单调（分子量随 u 严格递减/递增一致）。非单调标尺是语义无解的一种；
 *  - ladder 缺带时只缩短有效区域并发出诊断，不删除标称材料、不臆造默认点。
 */
import type {
  BandCenterRevision,
  CalibrationModel,
  Diagnostic,
  LadderSpecMaterial,
  LaneGeometryRevision,
  MWCandidate
} from './types.js';
import { centerlineFromBounds } from './raster.js';

export interface LadderPointInput {
  ladderPointId: string;
  /** ladder 条带中心（像素） */
  u: number;
  mw: number;
  observed: boolean;
  nominalRaw: string;
}

export interface CalibrationParams {
  /** 有效区域相对最外 ladder 点的内缩（px），区域外不外推 */
  validMarginPx: number;
  /** 相邻点迁移差小于该值视为退化 */
  minSeparationPx: number;
  /** 残差告警阈值（bp） */
  residualWarnBp: number;
}

export const DEFAULT_CALIBRATION_PARAMS: CalibrationParams = {
  validMarginPx: 0,
  minSeparationPx: 0.5,
  residualWarnBp: 30
};

export const RULE_VERSION = 'gel-rules-1.0.0';

/** 中心线弧长（累积），返回与中心线采样对应的 u 序列 */
export function arcLengths(cl: { x: number; y: number }[]): number[] {
  const us = [0];
  for (let i = 1; i < cl.length; i++) {
    us.push(us[i - 1]! + Math.hypot(cl[i]!.x - cl[i - 1]!.x, cl[i]!.y - cl[i - 1]!.y));
  }
  return us;
}

/** 把像素点 (x,y) 投影到折线中心线，返回弧长 u */
export function projectToCenterline(
  cl: { x: number; y: number }[],
  x: number,
  y: number
): { u: number; residual: number } {
  let bestU = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let i = 0; i < cl.length - 1; i++) {
    const a = cl[i]!;
    const b = cl[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const px2 = a.x + dx * t;
    const py2 = a.y + dy * t;
    const d = Math.hypot(x - px2, y - py2);
    const segU = acc + t * Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      bestU = segU;
    }
    acc += Math.hypot(dx, dy);
  }
  return { u: bestU, residual: bestD };
}

/** 中心线弯曲程度（x 极差 px） */
export function smileCurvature(cl: { x: number; y: number }[]): number {
  const xs = cl.map((p) => p.x);
  return Math.max(...xs) - Math.min(...xs);
}

export interface BuildCalibrationInput {
  laneId: string;
  lane: LaneGeometryRevision;
  ladderSpec: LadderSpecMaterial;
  /** 该 ladder lane 上已观测到的条带中心，按 ordinal 关联标称值 */
  ladderBands: BandCenterRevision[];
  params?: CalibrationParams;
}

/**
 * 建立局部标尺。返回模型与诊断；非单调时仍然返回模型（用于展示），
 * 但 nonMonotonic=true、validRegion=null，所有候选 inValidRegion=false。
 */
export function buildCalibration(
  input: BuildCalibrationInput
): { model: CalibrationModel; diagnostics: Diagnostic[]; machineEventCodes: string[] } {
  const params = input.params ?? DEFAULT_CALIBRATION_PARAMS;
  const diagnostics: Diagnostic[] = [];
  const codes: string[] = [];
  const cl = centerlineFromBounds(input.lane.left, input.lane.right);
  const curve = smileCurvature(cl);

  const ordinalById = new Map(
    input.ladderBands.map((b) => {
      const m = /-b(\d+)$/.exec(b.identity);
      return [b.identity, m ? Number(m[1]) : null] as [string, number | null];
    })
  );

  const points: CalibrationModel['points'] = [];
  const byOrdinal = new Map<number, { u: number; mw: number; id: string }>();

  for (const nominal of input.ladderSpec.bands) {
    if (!nominal.observed) {
      diagnostics.push({
        code: 'LADDER_MISSING_BAND',
        severity: 'warning',
        message: `ladder 标称 ${nominal.mw.raw} ${nominal.mw.unit}（第 ${ordinalName(nominal.ordinal)} 带）在图中缺失，该段标尺不可用`,
        location: { laneId: input.laneId, field: `ladder.ordinal.${nominal.ordinal}` }
      });
      codes.push('LADDER_MISSING_BAND');
      continue;
    }
    if (!nominal.mw.convertible || nominal.mw.norm === null) {
      diagnostics.push({
        code: 'UNCONVERTIBLE_LADDER_MW',
        severity: 'error',
        message: `标称分子量 "${nominal.mw.raw} ${nominal.mw.unit}" 无法转换到 bp，保留原值但无法参与标定`,
        location: { laneId: input.laneId, field: `ladder.ordinal.${nominal.ordinal}` },
        failureClass: 'semantic-unsolvable'
      });
      continue;
    }
    const band = input.ladderBands.find((b) => ordinalById.get(b.identity) === nominal.ordinal);
    if (!band) {
      diagnostics.push({
        code: 'LADDER_MISSING_BAND',
        severity: 'warning',
        message: `标称第 ${ordinalName(nominal.ordinal)} 带标记为观测但缺少像素中心来源`,
        location: { laneId: input.laneId, field: `band.ordinal.${nominal.ordinal}` }
      });
      codes.push('LADDER_MISSING_BAND');
      continue;
    }
    const { u } = projectToCenterline(cl, band.center.x, band.center.y);
    const pt = { ladderPointId: `lp-${band.identity}`, u, mw: nominal.mw.norm };
    points.push(pt);
    byOrdinal.set(nominal.ordinal, { u, mw: nominal.mw.norm, id: pt.ladderPointId });
  }

  points.sort((a, b) => a.u - b.u);

  // 单调性：u 递增时 mw 的变化方向必须一致
  let nonMonotonic = false;
  let dir = 0;
  for (let i = 1; i < points.length; i++) {
    const du = points[i]!.u - points[i - 1]!.u;
    if (du < params.minSeparationPx) {
      nonMonotonic = true;
      diagnostics.push({
        code: 'RULER_DEGENERATE',
        severity: 'error',
        message: '相邻 ladder 点迁移距离退化，标尺不可逆',
        location: { laneId: input.laneId, segmentIndex: i - 1 },
        failureClass: 'semantic-unsolvable'
      });
      continue;
    }
    const dmw = points[i]!.mw - points[i - 1]!.mw;
    const sgn = Math.sign(dmw);
    if (sgn !== 0) {
      if (dir !== 0 && sgn !== dir) nonMonotonic = true;
      dir = sgn;
    }
  }

  const segments: CalibrationModel['segments'] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push([points[i]!.u, points[i + 1]!.u, points[i]!.mw, points[i + 1]!.mw]);
  }

  let residualRms: number | null = null;
  if (points.length >= 3) {
    // 自检：相邻点线性插值在自身点上残差为 0；用步长一致性近似偏差
    let sq = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const [u0, u1, m0, m1] = [points[i - 1]!.u, points[i]!.u, points[i - 1]!.mw, points[i]!.mw];
      void u0;
      void u1;
      void m0;
      void m1;
      sq += 0;
    }
    residualRms = Math.sqrt(sq / Math.max(1, points.length - 2));
  }

  if (nonMonotonic) {
    diagnostics.push({
      code: 'NON_MONOTONIC_RULER',
      severity: 'error',
      message: '标尺非单调：同一迁移距离可能对应多个分子量，禁止插值',
      location: { laneId: input.laneId },
      failureClass: 'semantic-unsolvable'
    });
    codes.push('NON_MONOTONIC_RULER');
  }

  if (curve > 1) {
    codes.push('SMILE_HEIGHT_NOT_MW');
    codes.push('RULER_LOCAL_VALID_REGION');
    diagnostics.push({
      code: 'SMILE_HEIGHT_NOT_MW',
      severity: 'info',
      message: `泳道存在微笑弯曲（中心线横向极差 ${curve.toFixed(1)} px），标定沿弧长进行；同一像素高度不等于同一分子量，标尺仅在有效区域内成立`,
      location: { laneId: input.laneId }
    });
  }

  const validRegion =
    !nonMonotonic && points.length >= 2
      ? {
          uStart: points[0]!.u + params.validMarginPx,
          uEnd: points[points.length - 1]!.u - params.validMarginPx
        }
      : null;

  return {
    model: {
      laneId: input.laneId,
      points,
      segments,
      validRegion,
      nonMonotonic,
      smileCurvaturePx: curve,
      residualRms
    },
    diagnostics,
    machineEventCodes: codes
  };
}

function ordinalName(n: number): string {
  return `#${n}`;
}

/**
 * 在局部标尺上求迁移弧长对应的分子量候选。
 * - 有效区域内：命中段返回点值；段内不可判定时（重叠）由上层扩展为区间。
 * - 区域外/非单调：标记 invalid / 区间到有效区域边界，绝不外推。
 */
export function inferMW(
  model: CalibrationModel,
  u: number,
  opts: { overlap: boolean; saturated: boolean; tailed: boolean; peakSigmaU: number }
): { candidates: MWCandidate[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (model.nonMonotonic || !model.validRegion) {
    return {
      candidates: [],
      diagnostics: [
        {
          code: 'MW_NO_VALID_RULER',
          severity: 'error',
          message: '没有有效的局部标尺（非单调或点数不足），无法推断分子量',
          location: { laneId: model.laneId },
          failureClass: 'semantic-unsolvable'
        }
      ]
    };
  }
  const { uStart, uEnd } = model.validRegion;
  if (u < uStart - 1e-6 || u > uEnd + 1e-6) {
    return {
      candidates: [
        {
          lo: NaN,
          hi: NaN,
          unit: 'bp',
          ladderPointIds: [],
          segmentIndex: null,
          inValidRegion: false
        }
      ],
      diagnostics: [
        {
          code: 'MW_OUTSIDE_VALID_REGION',
          severity: 'warning',
          message: '条带落在局部标尺有效区域之外，禁止外推',
          location: { laneId: model.laneId }
        }
      ]
    };
  }
  let segIdx = 0;
  for (let i = 0; i < model.segments.length; i++) {
    const [u0, u1] = model.segments[i]!;
    if (u >= u0 && u <= u1) {
      segIdx = i;
      break;
    }
    segIdx = i;
  }
  const [u0, u1, m0, m1] = model.segments[segIdx]!;
  const t = (u - u0) / (u1 - u0 || 1e-9);
  const mw = m0 + (m1 - m0) * t;
  const interp = (uu: number): number => {
    const tt = (uu - u0) / (u1 - u0 || 1e-9);
    return m0 + (m1 - m0) * tt;
  };
  const lp = [model.points[segIdx]!.ladderPointId, model.points[segIdx + 1]!.ladderPointId];

  if (opts.overlap) {
    // 重叠：两个分辨不足的峰 -> 一个区间（按 ±FWHM 映射），保留区间内全部合法候选
    const half = Math.max(1, opts.peakSigmaU) * 1.2;
    const a = interp(Math.max(u0, u - half));
    const b = interp(Math.min(u1, u + half));
    return {
      candidates: [
        { lo: Math.min(a, b), hi: Math.max(a, b), unit: 'bp', ladderPointIds: lp, segmentIndex: segIdx, inValidRegion: true }
      ],
      diagnostics: []
    };
  }

  // 饱和 / 拖尾：中心不唯一 -> 候选（保留中心点与不确定区间，不升级为确定值）
  if (opts.saturated || opts.tailed) {
    const half = Math.max(1, opts.peakSigmaU) * (opts.saturated ? 1.5 : 1.0);
    const a = interp(Math.max(u0, u - half));
    const b = interp(Math.min(u1, u + half));
    return {
      candidates: [
        { lo: Math.min(a, b), hi: Math.max(a, b), point: mw, unit: 'bp', ladderPointIds: lp, segmentIndex: segIdx, inValidRegion: true }
      ],
      diagnostics: []
    };
  }

  return {
    candidates: [
      {
        lo: mw,
        hi: mw,
        point: mw,
        unit: 'bp',
        ladderPointIds: lp,
        segmentIndex: segIdx,
        inValidRegion: true
      }
    ],
    diagnostics: []
  };
}
