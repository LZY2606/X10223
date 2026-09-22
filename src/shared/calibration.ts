// 分子量校准内核（纯函数，可在服务端与测试中直接调用）。
// 模型：沿泳道弧长 s 与 log(MW) 的分段线性插值；每段带状态与有效区域。
import type {
  BandMaterial,
  BandInference,
  CalibrationAnchor,
  CalibrationSegment,
  CoordinateBasis,
  Diagnostic,
  LaneCalibration,
  LaneMaterial,
  LadderLinkMaterial,
  LadderSpecMaterial,
  MwHypothesis,
  ParameterSet
} from './types.ts';
import { densify, projectToLane } from './geometry.ts';
import { contentId } from './hash.ts';

export interface CalibrationInput {
  lane: LaneMaterial;
  ladderBands: BandMaterial[];
  sampleBands: BandMaterial[];
  ladderSpec: LadderSpecMaterial;
  link: LadderLinkMaterial;
  params: ParameterSet;
  at: string;
}

function diag(code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, materialId?: string, field?: string): Diagnostic {
  return { code, severity, message, position: { materialId, field } };
}

export function buildLaneCalibration(input: CalibrationInput): LaneCalibration {
  const { lane, ladderBands, ladderSpec, link, params, at } = input;
  const basis: CoordinateBasis = { kind: 'pixel-image', imageId: lane.imageId, origin: 'top-left', xAxis: 'right', yAxis: 'down' };
  const dense = densify(lane.controlPoints, basis, 1);

  const nominalByOrder = new Map(ladderSpec.bands.map((b) => [b.orderFromTop, b]));
  const bandById = new Map(ladderBands.map((b) => [b.id, b]));

  // 观测锚点：弧长 -> 标称分子量。
  const observed = ladderBands
    .map((band) => {
      const order = link.assignments[band.id];
      if (order === undefined) return null;
      const nominal = nominalByOrder.get(order);
      if (!nominal) return null;
      const proj = projectToLane(dense, band.center);
      return { band, order, nominal, s: proj.s, foot: proj.foot };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.s - b.s);

  const anchors: CalibrationAnchor[] = observed.map((o) => ({
    bandId: o.band.id,
    orderFromTop: o.order,
    s: round(o.s),
    center: o.band.center,
    molecularWeight: { ...o.nominal.molecularWeight },
    present: true,
    logMW: Math.log(o.nominal.molecularWeight.value)
  }));

  const diagnostics: Diagnostic[] = [];
  for (const missing of link.missingBands) {
    if (!nominalByOrder.has(missing)) {
      diagnostics.push(diag('D-MISSING-NOMINAL', 'error', `link 声明缺失 order=${missing}，但 ladder 规格中不存在该标称带`, link.id, 'missingBands'));
    } else {
      diagnostics.push(diag('D-MISSING-BAND', 'warning', `ladder 缺带 order=${missing} (${nominalByOrder.get(missing)!.label})`, link.id, 'missingBands'));
    }
  }

  const segments: CalibrationSegment[] = [];
  const unit = ladderSpec.unit;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    const ds = b.s - a.s;
    const dLog = b.logMW! - a.logMW!;
    const orderJump = b.orderFromTop - a.orderFromTop;
    let status: CalibrationSegment['status'] = 'valid';
    const reasonCode: string[] = [];

    if (ds <= 1e-6) {
      status = 'invalid-nonmonotonic';
      reasonCode.push('zero-arc-length');
    } else if (dLog >= 0) {
      // 迁移距离增大（向下）时 MW 必须减小 => logMW 必须递减。
      status = 'invalid-nonmonotonic';
      reasonCode.push('mw-not-decreasing');
    } else if (orderJump > 1) {
      status = params.calibration.maxGapOrder >= orderJump - 1 ? 'valid' : 'gap-missing-band';
      reasonCode.push('missing-band-gap');
    }

    const slope = ds === 0 ? NaN : dLog / ds;
    segments.push({
      id: `seg_${a.bandId.slice(-6)}_${b.bandId.slice(-6)}`,
      anchorA: a.bandId,
      anchorB: b.bandId,
      sA: round(a.s),
      sB: round(b.s),
      logA: a.logMW!,
      logB: b.logMW!,
      slope: round(slope),
      status,
      reasonCode: reasonCode[0],
      validRegion: status === 'valid' ? { sMin: round(a.s), sMax: round(b.s) } : null
    });
  }

  if (anchors.length >= 2) {
    const valid = anchors.slice().sort((x, y) => x.s - y.s);
    const n = valid.length;
    const meanS = valid.reduce((z, x) => z + x.s, 0) / n;
    const meanL = valid.reduce((z, x) => z + x.logMW!, 0) / n;
    let num = 0;
    let den = 0;
    for (const x of valid) {
      num += (x.s - meanS) * (x.logMW! - meanL);
      den += (x.s - meanS) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanL - slope * meanS;
    for (const x of anchors) {
      const residual = x.logMW! - (slope * x.s + intercept);
      x.residualLog = round(residual);
    }
  }

  const calibId = contentId('calib', {
    lane: lane.id,
    link: link.id,
    spec: ladderSpec.id,
    pv: params.version,
    anchors: anchors.map((a) => [a.bandId, a.s, a.orderFromTop])
  });

  if (anchors.length < 2) {
    diagnostics.push(diag('D-UNSOLVABLE-CALIB', 'error', `泳道 ${lane.label} 有效 ladder 锚点不足 2 个，无法建立标尺`, lane.id));
  }

  return {
    kind: 'laneCalibration',
    id: calibId,
    laneId: lane.id,
    ladderSpecId: ladderSpec.id,
    ladderLinkId: link.id,
    parameterVersion: params.version,
    basis,
    anchors,
    segments,
    residuals: anchors.map((a) => ({ bandId: a.bandId, residualLog: a.residualLog ?? 0 })),
    diagnostics
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
