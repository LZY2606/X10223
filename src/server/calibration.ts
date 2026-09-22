import { projectToCenterline } from '../shared/geometry.js';
import { contentId } from '../shared/ids.js';
import { diag } from '../shared/diagnostics.js';
import type {
  BandInference,
  BandMaterial,
  CalibrationResult,
  CalibrationSegment,
  ComputationResult,
  LadderMatch,
  LadderMaterial,
  LaneMaterial,
  MaterialBundle,
  MwCandidate,
  ParameterSet,
  Provenance,
} from '../shared/types.js';

/** 沿弧方向：弧长越大迁移越远 -> 分子量越小。在 log10(分子量) 空间线性插值。 */

export function computeBandAlong(band: BandMaterial, lane: LaneMaterial): number {
  return projectToCenterline(band.center, lane.centerline).alongPx;
}

/**
 * Ladder 标称值与 ladder 泳道条带的单调对齐（DP）。
 * 标称值按分子量降序（大->小，弧长升序）；缺带时跳过标称值。
 * 非单调标尺来自人工源数据：直接按给定顺序配对后逐段判定，不做自动重排。
 */
export function matchLadder(
  ladder: LadderMaterial,
  ladderBands: BandMaterial[],
  lane: LaneMaterial,
): { matches: LadderMatch[]; nonMonotonicNominal: boolean } {
  const usable = ladderBands
    .filter((b) => b.status !== 'rejected')
    .map((b) => ({ band: b, along: computeBandAlong(b, lane) }))
    .sort((a, b) => a.along - b.along);

  const nomDesc = [...ladder.nominals].sort(
    (a, b) => (b.nominal.parsed ?? -Infinity) - (a.nominal.parsed ?? -Infinity),
  );

  // 非单调标尺只看源数据声明顺序（目录顺序：大->小）；排序后永远单调，不能排序后再判断
  const nonMonotonicNominal = ladder.nominals.some((n, i) => {
    if (i === 0 || n.nominal.parsed == null) return false;
    const prev = ladder.nominals[i - 1].nominal.parsed;
    return prev != null && n.nominal.parsed > prev;
  });

  const matches: LadderMatch[] = [];
  // 人工对齐优先：非单调标尺场景下按源数据声明直接配对，再逐段判失效
  const manual = ladderBands.some((b) => b.ladderNominalId != null);
  if (nonMonotonicNominal || manual) {
    ladder.nominals.forEach((nom, i) => {
      const band = ladderBands.find((b) => b.ladderNominalId === nom.id) ?? (!manual ? usable[i]?.band : null) ?? null;
      if (nom.missing || !band) {
        matches.push({
          nominalId: nom.id,
          bandId: null,
          alongPx: null,
          matched: false,
          diagnostic: diag(
            'LADDER_BAND_MISSING',
            'warning',
            `ladder 标称 ${nom.nominal.rawText ?? nom.nominal.parsed} 缺带或无对应条带`,
            { objectId: nom.id, objectKind: 'ladderNominal', path: `nominals[${i}]` },
          ),
        });
      } else {
        matches.push({ nominalId: nom.id, bandId: band.id, alongPx: computeBandAlong(band, lane), matched: true });
      }
    });
    return { matches, nonMonotonicNominal };
  }

  // DP：在条带序列中为标称值寻找单调匹配，允许缺带（跳过标称值或条带）
  const n = nomDesc.length;
  const m = usable.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-Infinity));
  const take: (0 | 1)[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  score[0].fill(0);
  for (let i = 1; i <= n; i++) {
    const nom = nomDesc[i - 1];
    for (let j = 1; j <= m; j++) {
      const skipBand = score[i][j - 1];
      let takeVal = -Infinity;
      if (!nom.missing && nom.nominal.parsed != null) {
        takeVal = score[i - 1][j - 1] + 1;
      }
      if (takeVal > skipBand) {
        score[i][j] = takeVal;
        take[i][j] = 1;
      } else {
        score[i][j] = skipBand;
      }
    }
  }
  const chosen = new Map<string, string>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (take[i][j] === 1) {
      chosen.set(nomDesc[i - 1].id, usable[j - 1].band.id);
      i--;
      j--;
    } else {
      j--;
    }
  }
  for (let k = 0; k < ladder.nominals.length; k++) {
    const nom = ladder.nominals[k];
    const bandId = chosen.get(nom.id) ?? null;
    if (nom.missing || !bandId) {
      matches.push({
        nominalId: nom.id,
        bandId: null,
        alongPx: null,
        matched: false,
        diagnostic: diag(
          'LADDER_BAND_MISSING',
          nom.missing ? 'warning' : 'warning',
          `ladder 标称 ${nom.nominal.rawText ?? nom.nominal.parsed}${nom.missing ? ' 标记缺带' : ' 未找到对齐条带'}`,
          { objectId: nom.id, objectKind: 'ladderNominal', path: `nominals[${k}]` },
        ),
      });
    } else {
      const band = ladderBands.find((b) => b.id === bandId)!;
      matches.push({ nominalId: nom.id, bandId, alongPx: computeBandAlong(band, lane), matched: true });
    }
  }
  return { matches, nonMonotonicNominal: false };
}

/** 全局 log-线性拟合（用于残差展示与桥接区间） */
function globalLogFit(points: { along: number; logv: number }[]): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.along, 0);
  const sy = points.reduce((a, p) => a + p.logv, 0);
  const sxx = points.reduce((a, p) => a + p.along * p.along, 0);
  const sxy = points.reduce((a, p) => a + p.along * p.logv, 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

export function buildCalibration(
  bundle: MaterialBundle,
  params: ParameterSet,
  provenance: Provenance,
): CalibrationResult {
  const { ladder, lanes, bands } = bundle;
  const lane = lanes.find((l) => l.id === ladder.laneId)!;
  const ladderBands = bands.filter((b) => b.laneId === lane.id);
  const { matches, nonMonotonicNominal } = matchLadder(ladder, ladderBands, lane);
  const diagnostics: CalibrationResult['diagnostics'] = [];

  // 沿弧升序排列的匹配点（弧长越大、分子量越小）
  const points = matches
    .filter((m) => m.matched && m.alongPx != null)
    .map((m) => {
      const nominal = ladder.nominals.find((n) => n.id === m.nominalId)!;
      return { nominalId: m.nominalId, bandId: m.bandId!, along: m.alongPx!, logv: Math.log10(nominal.nominal.parsed!) };
    })
    .sort((a, b) => a.along - b.along);

  for (const m of matches) if (m.diagnostic) diagnostics.push(m.diagnostic);

  // 检测匹配后沿弧方向的非单调性（局部标尺失效）
  const monotonicFaults = new Set<number>();
  for (let i = 1; i < points.length; i++) {
    if (points[i].logv > points[i - 1].logv + params.monotonicTolerance) {
      monotonicFaults.add(i - 1);
      monotonicFaults.add(i);
      diagnostics.push(
        diag(
          'NONMONOTONIC_RULER',
          'error',
          `局部标尺非单调：沿弧 ${points[i - 1].along.toFixed(1)}px→${points[i].along.toFixed(1)}px 分子量未随迁移递减，该插值段失效`,
          { objectId: ladder.id, objectKind: 'ladder', segmentIndex: i - 1, pixel: ladderBands.find((b) => b.id === points[i].bandId)?.center },
        ),
      );
    }
  }
  if (nonMonotonicNominal) {
    diagnostics.push(
      diag(
        'NONMONOTONIC_RULER',
        'error',
        'ladder 标称值目录顺序非单调（源数据级标尺故障），仅逐段局部判定有效性',
        { objectId: ladder.id, objectKind: 'ladder', path: 'nominals' },
      ),
    );
  }

  // 相邻匹配点之间是否跨过缺带
  const missingNominalCount = matches.filter((m) => !m.matched).length;

  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    const segDiags: CalibrationSegment['diagnostics'] = [];
    const monotonic = hi.logv <= lo.logv + params.monotonicTolerance;
    // 缺带桥接：两点之间在目录标称序列中存在缺失标称值
    const order = [...ladder.nominals]
      .filter((n) => n.nominal.parsed != null)
      .sort((a, b) => (b.nominal.parsed ?? 0) - (a.nominal.parsed ?? 0));
    const iLo = order.findIndex((n) => n.id === lo.nominalId);
    const iHi = order.findIndex((n) => n.id === hi.nominalId);
    const bridge = iLo >= 0 && iHi >= 0 && iHi - iLo > 1;
    if (!monotonic) {
      segDiags.push(
        diag('NONMONOTONIC_RULER', 'error', `第 ${i} 段非单调，局部标尺失效`, {
          objectId: ladder.id,
          segmentIndex: i,
        }),
      );
    }
    if (bridge && params.bridgeMissingBands) {
      segDiags.push(
        diag('LADDER_BAND_MISSING', 'warning', `第 ${i} 段跨过 ${iHi - iLo - 1} 个缺带，桥接结果仅给区间`, {
          objectId: ladder.id,
          segmentIndex: i,
        }),
      );
    }
    segments.push({
      index: i,
      low: { nominalParsed: 10 ** lo.logv, alongPx: lo.along, nominalId: lo.nominalId },
      high: { nominalParsed: 10 ** hi.logv, alongPx: hi.along, nominalId: hi.nominalId },
      validAlong: [lo.along, hi.along],
      valid: monotonic && (params.bridgeMissingBands || !bridge),
      bridge: bridge && params.bridgeMissingBands,
      residualLog: 0,
      diagnostics: segDiags,
    });
  }

  const fit = globalLogFit(points.map((p) => ({ along: p.along, logv: p.logv })));
  const residuals = points.map((p) => ({
    bandId: p.bandId,
    alongPx: p.along,
    residualLog: fit ? p.logv - (fit.slope * p.along + fit.intercept) : 0,
  }));
  for (const seg of segments) {
    const a = residuals.find((r) => seg.low.nominalId === points.find((p) => p.bandId === r.bandId)?.nominalId);
    seg.residualLog = a?.residualLog ?? 0;
  }

  const validSegments = segments.filter((s) => s.valid);
  const globalValidAlong: [number, number] | null =
    validSegments.length > 0
      ? [Math.min(...validSegments.map((s) => s.validAlong[0])), Math.max(...validSegments.map((s) => s.validAlong[1]))]
      : null;

  const id = contentId('cal', {
    ladder: ladder.id,
    matches,
    params: params.id,
    input: provenance.inputSha256,
  });

  return {
    id,
    ladderId: ladder.id,
    laneId: lane.id,
    unit: ladder.unit,
    matches,
    segments,
    globalValidAlong,
    residuals,
    diagnostics,
    provenance,
  };
}

/** 在有效段上做 log 空间线性插值 */
function interpolateSegment(seg: CalibrationSegment, alongPx: number): number | null {
  if (alongPx < seg.validAlong[0] || alongPx > seg.validAlong[1]) return null;
  const t = (alongPx - seg.validAlong[0]) / (seg.validAlong[1] - seg.validAlong[0] || 1e-9);
  const logv =
    Math.log10(seg.low.nominalParsed) +
    t * (Math.log10(seg.high.nominalParsed) - Math.log10(seg.low.nominalParsed));
  return 10 ** logv;
}

export function inferBands(
  bundle: MaterialBundle,
  params: ParameterSet,
  calibration: CalibrationResult,
  provenance: Provenance,
): BandInference[] {
  const out: BandInference[] = [];
  for (const lane of bundle.lanes) {
    if (lane.id === calibration.laneId) continue;
    const laneBands = bundle.bands.filter((b) => b.laneId === lane.id);
    for (const band of laneBands) {
      const along = computeBandAlong(band, lane);
      const candidates: MwCandidate[] = [];
      const bandDiags: BandInference['diagnostics'] = [];

      calibration.segments.forEach((seg) => {
        const inside = along >= seg.validAlong[0] && along <= seg.validAlong[1];
        if (!inside) return;
        const value = interpolateSegment(seg, along);
        if (value == null) return;
        candidates.push({
          id: `${band.id}__seg${seg.index}`,
          value,
          unit: calibration.unit,
          segmentIndex: seg.index,
          ladderPointIds: [seg.low.nominalId, seg.high.nominalId],
          valid: seg.valid,
        });
      });

      // 饱和 / 拖尾：只能候选或区间
      if (band.saturated) {
        bandDiags.push(
          diag('SATURATED_BAND', 'warning', `条带中心 (${band.center.x},${band.center.y}) 像素饱和，峰顶被削平，分子量只能给区间`, {
            objectId: band.id,
            objectKind: 'band',
            pixel: band.center,
          }),
        );
      }
      if (band.smear) {
        bandDiags.push(
          diag('SMEARED_BAND', 'warning', `条带 (${band.center.x},${band.center.y}) 拖尾，质心位置不可唯一确定，只能给区间`, {
            objectId: band.id,
            objectKind: 'band',
            pixel: band.center,
          }),
        );
      }
      if (band.overlapsWith.length > 0) {
        bandDiags.push(
          diag('OVERLAPPING_BANDS', 'warning', `条带与 ${band.overlapsWith.join(', ')} 重叠，保留全部合法候选`, {
            objectId: band.id,
            objectKind: 'band',
            pixel: band.center,
          }),
        );
      }

      const validCandidates = candidates.filter((c) => c.valid);
      const inGlobalRange = calibration.globalValidAlong != null &&
        along >= calibration.globalValidAlong[0] && along <= calibration.globalValidAlong[1];

      let status: BandInference['status'];
      let point: number | null = null;
      let range: BandInference['range'] | null = null;
      let invalidReason: string | null = null;

      if (validCandidates.length === 0) {
        const hitsInvalidSegment = candidates.some((c) => !c.valid);
        if (hitsInvalidSegment) {
          status = 'invalid-nonmonotonic';
          invalidReason = '该位置落入非单调失效段，局部标尺不可用';
        } else if (!inGlobalRange) {
          status = params.forbidExtrapolation ? 'invalid-outside-range' : 'invalid-outside-range';
          invalidReason = params.forbidExtrapolation
            ? '位置超出 ladder 有效区间，且参数禁止外推'
            : '位置超出 ladder 有效区间';
          bandDiags.push(
            diag('OUTSIDE_VALID_RANGE', params.forbidExtrapolation ? 'error' : 'warning', invalidReason, {
              objectId: band.id,
              objectKind: 'band',
              pixel: band.center,
            }),
          );
        } else {
          status = 'invalid-nonmonotonic';
          invalidReason = '无有效插值段覆盖该沿弧位置';
        }
      } else if (band.saturated) {
        status = 'invalid-saturated-point';
        const vals = validCandidates.map((c) => c.value);
        range = { low: Math.min(...vals), high: Math.max(...vals), unit: calibration.unit };
        invalidReason = '饱和条带峰顶不可信，只给候选区间，不产生唯一点估计';
      } else if (band.smear || band.overlapsWith.length > 0 || validCandidates.length > 1) {
        status = 'candidate-set';
        const vals = validCandidates.map((c) => c.value);
        if (vals.length > 0) range = { low: Math.min(...vals), high: Math.max(...vals), unit: calibration.unit };
        if (!band.smear && band.overlapsWith.length === 0 && validCandidates.length === 1) {
          point = validCandidates[0].value;
        }
      } else {
        const only = validCandidates[0];
        if (calibration.segments[only.segmentIndex]?.bridge) {
          status = 'range-only';
          // 桥接段：围绕全局 log 线性拟合给加宽区间（±1 个残差量级，最少 5%）
          const w = Math.max(0.05, Math.max(...calibration.residuals.map((r) => Math.abs(r.residualLog))) * 2);
          range = { low: only.value * 10 ** -w, high: only.value * 10 ** w, unit: calibration.unit };
        } else {
          status = 'unique';
          point = only.value;
        }
      }

      out.push({
        id: contentId('mwi', { band: band.id, cal: calibration.id, along }),
        bandId: band.id,
        laneId: lane.id,
        alongPx: along,
        range,
        point,
        unit: calibration.unit,
        status,
        candidates,
        invalidReason,
        calibrationId: calibration.id,
        diagnostics: bandDiags,
        provenance,
      });
    }
  }
  return out;
}

export function runComputation(
  bundle: MaterialBundle,
  params: ParameterSet,
  parentResultIds: string[],
  eventSeq: number,
  inputSha256: string,
  atTime: string,
): ComputationResult {
  const provenance: Provenance = {
    inputSha256,
    paramsId: params.id,
    parentResultIds,
    eventSeq,
    computedAt: atTime,
  };
  const calibration = buildCalibration(bundle, params, provenance);
  const inferences = inferBands(bundle, params, calibration, provenance);
  const diagnostics = [...calibration.diagnostics, ...inferences.flatMap((i) => i.diagnostics)];
  const hasSemanticFault = diagnostics.some((d) => d.code === 'NONMONOTONIC_RULER');
  return {
    calibration,
    inferences,
    outcome: 'ok',
    diagnostics: diagnostics as ComputationResult['diagnostics'],
  };
}
