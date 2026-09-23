import type {
  BandRecord,
  Diagnostic,
  FitSegment,
  LadderAssignmentPoint,
  LadderCalibration,
  LadderSpec,
  LaneRecord,
  MassResult,
  MassUnit,
  Quantity,
} from './types.js';
import { contentId } from './ids.js';
import { diag } from './diagnostics.js';
import { qty } from './quantities.js';

interface BandLike {
  id: string;
  migration: number;
  saturated: boolean;
  smear: boolean;
  overlapsWith: string[];
  status: string;
}

/**
 * 将 ladder 标称值（降序质量）对齐到检测到的 ladder 条带（迁移升序）。
 * 允许缺带：枚举全部严格保序的对齐；多于一个合法对齐时返回全部候选。
 */
export function alignLadder(
  spec: LadderSpec,
  bands: BandLike[],
): {
  points: LadderAssignmentPoint[];
  alternatives: LadderAssignmentPoint[][];
  missingCount: number;
  ambiguous: boolean;
} {
  const usable = bands.filter((b) => b.status !== 'rejected').sort((a, b) => a.migration - b.migration);
  const nominals = [...spec.nominals].sort((a, b) => b.mass.value - a.mass.value); // 降序质量
  const n = nominals.length;
  const k = usable.length;
  const missingCount = n - k;

  const candidates: number[][] = [];
  const chosen: number[] = [];
  function enumerate(ni: number, bi: number) {
    if (chosen.length === k) {
      candidates.push([...chosen]);
      return;
    }
    if (ni >= n || bi >= k) return;
    for (let i = ni; i <= n - (k - chosen.length); i++) {
      chosen.push(i);
      enumerate(i + 1, bi + 1);
      chosen.pop();
    }
  }
  if (k > 0 && k <= n) enumerate(0, 0);

  const build = (picked: number[]): LadderAssignmentPoint[] =>
    picked.map((nomIdx, bandIdx) => {
      const nominal = nominals[nomIdx];
      const band = usable[bandIdx];
      return {
        nominalId: nominal.id,
        mass: nominal.mass,
        bandId: band.id,
        center: (band as BandRecord).center,
        migration: band.migration,
        logMass: Math.log10(nominal.mass.value),
      };
    });

  const alignments = candidates.map(build);
  return {
    points: alignments[0] ?? [],
    alternatives: alignments.slice(1),
    missingCount: Math.max(0, missingCount),
    ambiguous: alignments.length > 1,
  };
}

export interface CalibrationOutcome {
  calibration: LadderCalibration | null;
  diagnostics: Diagnostic[];
}

/**
 * 分段 log-linear 校准：相邻 ladder 点之间拟一条局部标尺段。
 * 非单调（迁移不严格递增）→ SEMANTIC_UNRESOLVABLE 事件，不生成标尺。
 * 缺带仍可插值，但会标注；超过最大标称的条带标 out-of-range。
 */
export function buildCalibration(
  spec: LadderSpec,
  ladderLane: LaneRecord,
  bands: BandRecord[],
): CalibrationOutcome {
  const diagnostics: Diagnostic[] = [];
  const laneBands = bands.filter((b) => b.laneId === ladderLane.id && b.status !== 'rejected');
  const { points, alternatives, missingCount, ambiguous } = alignLadder(spec, laneBands);

  if (points.length < 2) {
    diagnostics.push(
      diag('LADDER_MISSING_BAND', 'error', '可用 ladder 条带少于 2 个，无法建立标尺', {
        kind: 'lane',
        laneId: ladderLane.id,
      }),
    );
    return { calibration: null, diagnostics };
  }

  if (ambiguous) {
    diagnostics.push(
      diag('LADDER_MISSING_BAND', 'warning', `ladder 缺 ${missingCount} 带且存在 ${alternatives.length + 1} 种保序对齐，已保留全部候选`, {
        kind: 'lane',
        laneId: ladderLane.id,
        ids: points.map((p) => p.nominalId),
      }),
    );
  } else if (missingCount > 0) {
    diagnostics.push(
      diag('LADDER_MISSING_BAND', 'warning', `ladder 缺 ${missingCount} 个标称带，标尺在缺带处只能跨段插值`, {
        kind: 'lane',
        laneId: ladderLane.id,
      }),
    );
  }

  let nonMonotonic = false;
  for (let i = 1; i < points.length; i++) {
    if (points[i].migration <= points[i - 1].migration) {
      nonMonotonic = true;
      diagnostics.push(
        diag('NON_MONOTONIC_RULER', 'error', `ladder 点 ${points[i].nominalId} 的迁移距离不严格递增，标尺语义无解`, {
          kind: 'band',
          bandId: points[i].bandId,
          point: points[i].center,
          laneId: ladderLane.id,
        }),
      );
    }
    if (points[i].logMass >= points[i - 1].logMass) {
      nonMonotonic = true;
      diagnostics.push(
        diag('NON_MONOTONIC_RULER', 'error', `标称分子量 ${points[i].mass.raw} 未按降序排列，标尺非单调`, {
          kind: 'band',
          bandId: points[i].bandId,
          laneId: ladderLane.id,
        }),
      );
    }
  }

  if (nonMonotonic) {
    return {
      calibration: {
        ladderLaneId: ladderLane.id,
        ladderId: spec.id,
        points,
        segments: [],
        globalResiduals: [],
        validRange: { from: points[0].mass, to: points[points.length - 1].mass },
        nonMonotonic: true,
        diagnostics,
      },
      diagnostics,
    };
  }

  const segments: FitSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const slope = (b.logMass - a.logMass) / (b.migration - a.migration);
    const intercept = a.logMass - slope * a.migration;
    const id = contentId('seg', {
      a: a.nominalId,
      b: b.nominalId,
      ma: a.migration,
      mb: b.migration,
    });
    segments.push({
      id,
      startNominalId: a.nominalId,
      endNominalId: b.nominalId,
      startBandId: a.bandId,
      endBandId: b.bandId,
      slope,
      intercept,
      validFromMigration: a.migration,
      validToMigration: b.migration,
      residual: 0,
    });
  }

  const globalResiduals = points.map((p) => {
    const seg = segmentFor(segments, p.migration)!;
    const pred = seg.slope * p.migration + seg.intercept;
    return { nominalId: p.nominalId, residual: p.logMass - pred };
  });

  return {
    calibration: {
      ladderLaneId: ladderLane.id,
      ladderId: spec.id,
      points,
      segments,
      globalResiduals,
      validRange: { from: points[0].mass, to: points[points.length - 1].mass },
      nonMonotonic: false,
      diagnostics,
    },
    diagnostics,
  };
}

function segmentFor(segments: FitSegment[], migration: number): FitSegment | null {
  if (segments.length === 0) return null;
  for (const s of segments) {
    if (migration >= s.validFromMigration - 1e-9 && migration <= s.validToMigration + 1e-9) return s;
  }
  if (migration < segments[0].validFromMigration) return segments[0];
  return segments[segments.length - 1];
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function massFromLog(logMass: number, unit: MassUnit): Quantity<number, MassUnit> {
  return qty(r3(10 ** logMass), unit);
}

export interface MassOptions {
  paramsVersion: string;
  /** 饱和区间半宽（迁移距离 px），依据 band 高度给出 */
  saturationHalfWidth?: number;
}

/**
 * 对非 ladder 泳道条带推断分子量。
 * - 局部标尺段带有效区域；越界 → out-of-range（不外推）。
 * - 饱和/拖尾/重叠 → range 或 ambiguous，绝不伪装唯一值。
 * - 修订后局部失效 → invalid + LOCAL_RULER_INVALID。
 */
export function inferMasses(
  calibration: LadderCalibration,
  lanes: LaneRecord[],
  bands: BandRecord[],
  options: MassOptions,
  parentResultIds: string[] = [],
): { results: MassResult[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const results: MassResult[] = [];
  const unit = calibration.validRange.from.unit;

  if (calibration.nonMonotonic || calibration.segments.length === 0) {
    for (const band of bands.filter((b) => b.laneId !== calibration.ladderLaneId && b.status !== 'rejected')) {
      diagnostics.push(
        diag('LOCAL_RULER_INVALID', 'error', '标尺非单调，局部标尺在整条泳道失效', {
          kind: 'band',
          bandId: band.id,
          laneId: band.laneId,
          point: band.center,
        }),
      );
      results.push({
        id: contentId('mass', { band: band.id, invalid: true }),
        bandId: band.id,
        laneId: band.laneId,
        mass: null,
        migration: band.migration ?? 0,
        usedLadderPointIds: [],
        status: 'invalid',
        reason: 'non-monotonic-ruler',
        diagnostics: [],
        paramsVersion: options.paramsVersion,
        parentResultIds,
      });
    }
    return { results, diagnostics };
  }

  const migMin = calibration.segments[0].validFromMigration;
  const migMax = calibration.segments[calibration.segments.length - 1].validToMigration;

  for (const band of bands.filter((b) => b.laneId !== calibration.ladderLaneId && b.status !== 'rejected')) {
    const lane = lanes.find((l) => l.id === band.laneId);
    const localDiags: Diagnostic[] = [];
    const migration = band.migration ?? 0;
    const baseId = contentId('mass', {
      band: band.id,
      migration,
      params: options.paramsVersion,
    });

    if (migration < migMin - 1e-9 || migration > migMax + 1e-9) {
      localDiags.push(
        diag('OUTSIDE_VALID_RANGE', 'warning', `迁移距离 ${r3(migration)}px 超出局部标尺有效区域 [${r3(migMin)}, ${r3(migMax)}]px，不外推`, {
          kind: 'band',
          bandId: band.id,
          laneId: band.laneId,
          point: band.center,
          validRange: {
            from: { ...calibration.validRange.from },
            to: { ...calibration.validRange.to },
          },
        }),
      );
      results.push({
        id: baseId,
        bandId: band.id,
        laneId: band.laneId ?? '',
        mass: null,
        migration,
        usedLadderPointIds: [],
        status: 'out-of-range',
        reason: 'outside-valid-range',
        diagnostics: localDiags,
        paramsVersion: options.paramsVersion,
        parentResultIds,
      });
      diagnostics.push(...localDiags);
      continue;
    }

    const seg = segmentFor(calibration.segments, migration)!;
    const ladderPointIds = [seg.startNominalId, seg.endNominalId];
    const halfWidth = Math.max(1.5, options.saturationHalfWidth ?? band.height * 0.8);

    // 重叠：按重叠簇中每个条带的候选中心各给一个合法分子量
    if (band.overlapsWith.length > 0 && !band.saturated && !band.smear) {
      const candidates = new Set<number>();
      for (const m of [migration, migration - halfWidth, migration + halfWidth]) {
        if (m >= migMin - 1e-9 && m <= migMax + 1e-9) {
          const s = segmentFor(calibration.segments, m)!;
          candidates.add(r3(10 ** (s.slope * m + s.intercept)));
        }
      }
      localDiags.push(
        diag('OVERLAPPING_BANDS', 'warning', '重叠条带无法唯一定位，保留全部合法候选分子量', {
          kind: 'band',
          bandId: band.id,
          laneId: band.laneId,
          point: band.center,
        }),
      );
      results.push({
        id: baseId,
        bandId: band.id,
        laneId: band.laneId ?? '',
        mass: null,
        candidates: [...candidates].sort((a, b) => b - a).map((v) => qty(v, unit)),
        migration,
        segmentId: seg.id,
        usedLadderPointIds: ladderPointIds,
        status: 'ambiguous',
        reason: 'overlap',
        diagnostics: localDiags,
        paramsVersion: options.paramsVersion,
        parentResultIds,
      });
      diagnostics.push(...localDiags);
      continue;
    }

    if (band.saturated || band.smear) {
      const ms = [migration - halfWidth, migration + halfWidth].map((m) =>
        Math.min(migMax, Math.max(migMin, m)),
      );
      const logs = ms.map((m) => {
        const s = segmentFor(calibration.segments, m)!;
        return s.slope * m + s.intercept;
      });
      const hi = massFromLog(Math.max(...logs), unit);
      const lo = massFromLog(Math.min(...logs), unit);
      localDiags.push(
        diag(
          band.saturated ? 'SATURATED_BAND' : 'SMEAR_TAIL',
          'warning',
          band.saturated ? '饱和条带中心不可信，只给分子量区间' : '拖尾条带迁移不可信，只给分子量区间',
          { kind: 'band', bandId: band.id, laneId: band.laneId, point: band.center },
        ),
      );
      results.push({
        id: baseId,
        bandId: band.id,
        laneId: band.laneId ?? '',
        mass: null,
        range: { from: lo, to: hi },
        migration,
        segmentId: seg.id,
        usedLadderPointIds: ladderPointIds,
        status: 'range',
        reason: band.saturated ? 'saturation' : 'smear',
        diagnostics: localDiags,
        paramsVersion: options.paramsVersion,
        parentResultIds,
      });
      diagnostics.push(...localDiags);
      continue;
    }

    const logMass = seg.slope * migration + seg.intercept;
    results.push({
      id: baseId,
      bandId: band.id,
      laneId: band.laneId ?? '',
      mass: massFromLog(logMass, unit),
      migration,
      segmentId: seg.id,
      usedLadderPointIds: ladderPointIds,
      status: lane && lane.status === 'accepted' ? 'accepted' : 'candidate',
      diagnostics: [],
      paramsVersion: options.paramsVersion,
      parentResultIds,
    });
  }

  return { results, diagnostics };
}
