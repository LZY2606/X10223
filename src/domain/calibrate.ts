import type {
  AlignmentAnchor,
  BandMaterial,
  BandResult,
  CalibrationParams,
  Diagnostic,
  LadderNominalMaterial,
  LaneMaterial,
  Qty,
  Ruler,
  RulerPoint,
  RulerSegment
} from "../shared/types.js";
import { asQty, makeQty } from "./units.js";
import { projectPointToPolyline, polylineLength } from "./geometry.js";
import { stableId } from "../shared/ids.js";

interface AnchorPoint {
  label: string;
  bandId: string;
  fraction: number;
  mw: number;
  mwQty: Qty;
  raw: Qty;
}

function diag(
  code: Diagnostic["code"],
  severity: Diagnostic["severity"],
  path: string,
  message: string,
  objectIds?: string[]
): Diagnostic {
  return { code, severity, path, message, objectIds };
}

export function arcFractionAlong(lane: LaneMaterial, p: { x: number; y: number }): number {
  const proj = projectPointToPolyline(p, lane.centerline);
  return proj.arc / polylineLength(lane.centerline);
}

export function mapFractionToLadder(fraction: number, anchors: AlignmentAnchor[]): number {
  if (anchors.length === 0) return fraction;
  const sorted = [...anchors].sort((a, b) => a.laneArcFraction - b.laneArcFraction);
  if (fraction <= sorted[0].laneArcFraction) {
    const a = sorted[0];
    return a.ladderArcFraction + (fraction - a.laneArcFraction);
  }
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (fraction <= b.laneArcFraction) {
      const t = b.laneArcFraction === a.laneArcFraction ? 0 : (fraction - a.laneArcFraction) / (b.laneArcFraction - a.laneArcFraction);
      return a.ladderArcFraction + t * (b.ladderArcFraction - a.ladderArcFraction);
    }
  }
  const last = sorted[sorted.length - 1];
  return last.ladderArcFraction + (fraction - last.laneArcFraction);
}

export interface RulerBuildInput {
  ladderLane: LaneMaterial;
  ladderNominal: LadderNominalMaterial;
  ladderBands: BandMaterial[];
  params: CalibrationParams;
}

export function buildRuler(input: RulerBuildInput): Ruler {
  const diagnostics: Diagnostic[] = [];
  const { ladderLane, ladderNominal, ladderBands, params } = input;
  const ladderLen = polylineLength(ladderLane.centerline);
  const unitDiags: Diagnostic[] = [];
  const anchorsByLabel = new Map<string, AnchorPoint>();

  for (const nominal of ladderNominal.bands) {
    const qty = asQty(nominal.molecularWeight, `ladder/${ladderNominal.laneId}/bands/${nominal.label}`, unitDiags);
    if (qty.valueCanonical === undefined) continue;
    if (!nominal.present) {
      diagnostics.push(
        diag("SEMANTIC_LADDER_BAND_MISSING", "warning",
          `ladder/${ladderNominal.laneId}/bands/${nominal.label}`,
          `ladder 标称带 ${nominal.label}（${qty.value}${qty.unit}）在图像中缺带，不能作为锚点`)
      );
      continue;
    }
    const band = ladderBands.find((b) => b.ladderLabel === nominal.label);
    if (!band) {
      diagnostics.push(
        diag("SEMANTIC_LADDER_BAND_MISSING", "warning",
          `ladder/${ladderNominal.laneId}/bands/${nominal.label}`,
          `标称带 ${nominal.label} 存在但缺少像素级条带中心，不能作为锚点`,
          [ladderLane.id])
      );
      continue;
    }
    const fraction = arcFractionAlong(ladderLane, band.center);
    anchorsByLabel.set(nominal.label, {
      label: nominal.label,
      bandId: band.id,
      fraction,
      mw: qty.valueCanonical,
      mwQty: qty,
      raw: qty
    });
  }
  diagnostics.push(...unitDiags);

  const ordered = [...anchorsByLabel.values()].sort((a, b) => a.fraction - b.fraction);
  let nonMonotonic = false;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].mw >= ordered[i - 1].mw) {
      nonMonotonic = true;
      diagnostics.push(
        diag("SEMANTIC_NONMONOTONIC_RULER", "error",
          `ruler/${targetLane.id}/segments`,
          `标尺非单调：迁移 ${ordered[i - 1].fraction.toFixed(3)}→${ordered[i].fraction.toFixed(3)} 时分子量 ${ordered[i - 1].mw}→${ordered[i].mw} 未严格下降`,
          [ladderLane.id, ordered[i].bandId, ordered[i - 1].bandId])
      );
    }
  }

  const segments: RulerSegment[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    segments.push({
      id: stableId("seg", params.id, targetLane.id, a.label, b.label),
      labelA: a.label,
      labelB: b.label,
      migrationA: a.fraction * ladderLen,
      migrationB: b.fraction * ladderLen,
      mwA: a.mw,
      mwB: b.mw,
      valid: !nonMonotonic && b.mw < a.mw && b.fraction > a.fraction
    });
  }

  const points: RulerPoint[] = ordered.map((a) => ({
    bandId: a.bandId,
    label: a.label,
    migration: a.fraction * ladderLen,
    molecularWeight: a.raw,
    residual: makeQty(0, a.raw.canonicalUnit ?? "bp", "0", a.raw.unit),
    withinValidRegion: true
  }));

  if (params.interpolation === "semilog-linear" && ordered.length >= 3 && !nonMonotonic) {
    const xs = ordered.map((a) => a.fraction * ladderLen);
    const ys = ordered.map((a) => Math.log(a.mw));
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = my - slope * mx;
    for (const point of points) {
      const fitted = Math.exp(slope * point.migration + intercept);
      const actual = point.molecularWeight.valueCanonical!;
      point.residual = makeQty(actual - fitted, point.molecularWeight.canonicalUnit ?? "bp",
        String(actual - fitted), point.molecularWeight.unit);
    }
  }

  const validRegion = ordered.length >= 2 && !nonMonotonic
    ? {
        migrationMin: ordered[0].fraction * ladderLen - params.extrapolationTolerancePx,
        migrationMax: ordered[ordered.length - 1].fraction * ladderLen + params.extrapolationTolerancePx
      }
    : null;

  if (ordered.length < 2) {
    diagnostics.push(
      diag("SEMANTIC_NO_RULER", "error", `ruler/${targetLane.id}`,
        "可用于插值的 ladder 锚点少于 2 个，无法建立标尺", [targetLane.id])
    );
  }

  return {
    laneId: targetLane.id,
    frame: "ladder-migration",
    validRegion,
    points,
    segments,
    diagnostics
  };
}

function interpolateMw(ruler: Ruler, migration: number, params: CalibrationParams): { mw?: number; segmentId?: string; labels?: string[] } {
  for (const segment of ruler.segments) {
    if (!segment.valid) continue;
    if (migration >= Math.min(segment.migrationA, segment.migrationB) &&
        migration <= Math.max(segment.migrationA, segment.migrationB)) {
      const t = (migration - segment.migrationA) / (segment.migrationB - segment.migrationA);
      let mw: number;
      if (params.interpolation === "semilog-linear") {
        mw = Math.exp(Math.log(segment.mwA) + t * (Math.log(segment.mwB) - Math.log(segment.mwA)));
      } else {
        mw = segment.mwA + t * (segment.mwB - segment.mwA);
      }
      return { mw, segmentId: segment.id, labels: [segment.labelA, segment.labelB] };
    }
  }
  return {};
}

export interface BandInferenceInput {
  bands: BandMaterial[];
  lane: LaneMaterial;
  ladderLane: LaneMaterial;
  anchors: AlignmentAnchor[];
  ruler: Ruler;
  params: CalibrationParams;
  runStableKey: string;
}

export function inferBands(input: BandInferenceInput): BandResult[] {
  const { bands, lane, ladderLane, anchors, ruler, params, runStableKey } = input;
  const ladderLen = polylineLength(ladderLane.centerline);
  const laneLen = polylineLength(lane.centerline);
  const results: BandResult[] = [];
  const overlapGroups = new Map<string, BandMaterial[]>();
  for (const band of bands) {
    if (band.overlapGroupId) {
      const list = overlapGroups.get(band.overlapGroupId) ?? [];
      list.push(band);
      overlapGroups.set(band.overlapGroupId, list);
    }
  }

  for (const band of bands) {
    const diagnostics: Diagnostic[] = [];
    const laneFraction = arcFractionAlong(lane, band.center);
    const migration = mapFractionToLadder(laneFraction, anchors) * ladderLen;
    const unit = ruler.points[0]?.molecularWeight.canonicalUnit ?? "bp";
    const rawUnit = ruler.points[0]?.molecularWeight.unit ?? "bp";

    let status: BandResult["status"] = "unique";
    if (band.saturated) status = "invalid" === status ? status : "interval";
    if (band.shape === "tailed") status = "interval";
    if (band.shape === "overlapped" || band.overlapGroupId) status = "candidate";

    const inside = ruler.validRegion
      ? migration >= ruler.validRegion.migrationMin && migration <= ruler.validRegion.migrationMax
      : false;
    if (!inside) {
      status = "invalid";
      diagnostics.push(diag("OUTSIDE_VALID_REGION", "warning",
        `bands/${band.id}/migration`,
        `条带迁移位置 ${migration.toFixed(1)}px 位于标尺有效区间之外（局部标尺失效），不给唯一分子量`,
        [band.id, lane.id]));
    }

    const interp = inside ? interpolateMw(ruler, migration, params) : {};
    const candidates: Qty[] = [];
    const valueIds: string[] = [];
    let range: BandResult["range"];
    let point: Qty | undefined;

    if (interp.mw !== undefined) {
      const addCandidate = (mw: number, tag: string) => {
        const q = makeQty(mw, unit, roundRaw(mw), rawUnit);
        candidates.push(q);
        valueIds.push(stableId("val", runStableKey, band.id, tag));
      };

      if (status === "candidate" && band.overlapGroupId) {
        const group = overlapGroups.get(band.overlapGroupId) ?? [band];
        for (const mate of [...group].sort((a, b) => a.id.localeCompare(b.id))) {
          const mateFraction = arcFractionAlong(lane, mate.center);
          const mateMigration = mateFraction * ladderLen;
          const m = interpolateMw(ruler, mateMigration, params);
          if (m.mw !== undefined) addCandidate(m.mw, `overlap:${mate.id}`);
        }
        diagnostics.push(diag("OVERLAPPING_BANDS", "warning", `bands/${band.id}`,
          `条带与 ${group.filter((g) => g.id !== band.id).map((g) => g.id).join(", ")} 重叠，保留全部合法候选`,
          group.map((g) => g.id)));
      } else {
        addCandidate(interp.mw, "peak");
        point = makeQty(interp.mw, unit, roundRaw(interp.mw), rawUnit);
      }

      if (status === "interval") {
        const widthPx = band.peakWidthPx ?? 6;
        const span = Math.max(widthPx, 1);
        const lowMw = interpolateMw(ruler, Math.min(migration + span, (ruler.validRegion?.migrationMax ?? migration)), params).mw ?? interp.mw * 0.9;
        const highMw = interpolateMw(ruler, Math.max(migration - span, (ruler.validRegion?.migrationMin ?? migration)), params).mw ?? interp.mw * 1.1;
        const low = Math.min(lowMw, highMw);
        const high = Math.max(lowMw, highMw);
        range = {
          low: makeQty(low, unit, roundRaw(low), rawUnit),
          high: makeQty(high, unit, roundRaw(high), rawUnit)
        };
        valueIds.push(
          stableId("val", runStableKey, band.id, "interval:low"),
          stableId("val", runStableKey, band.id, "interval:high")
        );
      }

      if (band.saturated) {
        diagnostics.push(diag("SATURATED_REGION", "warning", `bands/${band.id}`,
          "条带中心位于饱和区，峰值迁移不可信，仅给区间/候选", [band.id]));
      }
      if (band.shape === "tailed" || band.tailing) {
        diagnostics.push(diag("TAILING_PRESENT", "warning", `bands/${band.id}`,
          "条带拖尾，峰值位置有偏，仅给区间", [band.id]));
      }
    }

    results.push({
      id: stableId("bres", runStableKey, band.id),
      bandId: band.id,
      laneId: lane.id,
      migration,
      status,
      candidates,
      range,
      point,
      segmentId: interp.segmentId,
      rulerPointLabels: interp.labels,
      diagnostics,
      valueIds
    });
  }

  return results.sort((a, b) => a.bandId.localeCompare(b.bandId));
}

function roundRaw(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

export function laneMigrationOfBand(band: BandMaterial, lane: LaneMaterial, ladderLane: LaneMaterial): number {
  const fraction = arcFractionAlong(lane, band.center);
  return fraction * polylineLength(ladderLane.centerline);
}

export const _internals = { laneLen: polylineLength };
