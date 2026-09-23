import {
  buildPolyline,
  orientPoint,
  orientPolyline,
  projectToPolyline,
  centerline,
} from "./geometry.js";
import { stableId } from "./hash.js";
import {
  KERNEL_VERSION,
  type InputDigest,
  type LadderPoint,
  type RulerPiece,
  type RulerResult,
} from "./kernel-types.js";
import type {
  BandCenter,
  ComputeContext as _C,
  Diagnostic,
  ImageMaterial,
  LaneBoundary,
  LadderNominal,
  OrientationMaterial,
} from "./types.js";
import type { GrayImage } from "./png.js";

interface NominalView {
  id: string;
  ordinal: number;
  rawText: string;
  q: LadderPoint["q"];
}

interface BandView {
  id: string;
  s: number;
  at: LadderPoint["at"];
}

/**
 * 枚举全部保持顺序的 ladder 标称→实际带对齐（实际带可能更少，即缺带）。
 * 对齐用索引序列表示：match[iNominal] = jBand 或 -1。
 * 数量受预算保护，过多对齐 → 只保留间隔代价最小的前 N 个（并在诊断中说明截断）。
 */
export function enumeratePairings(
  nominals: NominalView[],
  bands: BandView[],
  maxPairings: number,
): { match: number[]; cost: number; truncated: boolean }[] {
  const results: { match: number[]; cost: number }[] = [];
  const m = nominals.length;
  const n = bands.length;

  const spacingCost = (match: number[]): number => {
    // 理想情况下相邻匹配带间距应与 ln(MW) 差成正比；用相关一致性粗代价
    const pts: { s: number; lq: number }[] = [];
    match.forEach((j, i) => {
      if (j >= 0 && nominals[i]!.q) pts.push({ s: bands[j]!.s, lq: Math.log(nominals[i]!.q!.value) });
    });
    if (pts.length < 2) return 0;
    const ms = pts.reduce((a, p) => a + p.s, 0) / pts.length;
    const ml = pts.reduce((a, p) => a + p.lq, 0) / pts.length;
    let num = 0;
    let ds = 0;
    let dl = 0;
    for (const p of pts) {
      num += (p.s - ms) * (p.lq - ml);
      ds += (p.s - ms) ** 2;
      dl += (p.lq - ml) ** 2;
    }
    const r = ds * dl === 0 ? 0 : num / Math.sqrt(ds * dl);
    return Math.round((1 + Math.min(0, r)) * 1e6); // r 越接近 -1 代价越低
  };

  const rec = (i: number, j: number, match: number[]): void => {
    if (results.length > maxPairings * 4) return; // 预算保护
    if (i === m) {
      results.push({ match: [...match], cost: spacingCost(match) });
      return;
    }
    // 该标称缺带
    match.push(-1);
    rec(i + 1, j, match);
    match.pop();
    // 与第 j 条带配对（保持顺序）
    if (j < n) {
      match.push(j);
      rec(i + 1, j + 1, match);
      match.pop();
    }
  };
  rec(0, 0, [] as number[]);
  results.sort((a, b) => a.cost - b.cost);
  const truncated = results.length > maxPairings;
  return results.slice(0, maxPairings).map((r) => ({ ...r, truncated }));
}

function buildPieces(
  laneId: string,
  nominals: NominalView[],
  bands: BandView[],
  match: number[],
  pairingId: number,
  invalidNominals: Set<string>,
): { pieces: RulerPiece[]; nonMonotonic: Diagnostic[] } {
  const pieces: RulerPiece[] = [];
  const nonMonotonic: Diagnostic[] = [];
  interface MP {
    nominal: NominalView;
    band: BandView;
  }
  const matched: MP[] = [];
  match.forEach((j, i) => {
    if (j >= 0 && nominals[i]!.q) matched.push({ nominal: nominals[i]!, band: bands[j]! });
  });
  matched.sort((a, b) => a.band.s - b.band.s);
  for (let k = 0; k < matched.length - 1; k++) {
    const lo = matched[k]!;
    const hi = matched[k + 1]!;
    const sDelta = hi.band.s - lo.band.s;
    const qOk = lo.nominal.q!.value > hi.nominal.q!.value && sDelta > 0.5;
    if (!qOk) {
      invalidNominals.add(hi.nominal.id);
      nonMonotonic.push({
        code: "RULER_NONMONOTONIC",
        severity: "error",
        message: `ladder 标称在弧长 ${Math.round(hi.band.s)}px 处非单调（${lo.nominal.rawText} → ${hi.nominal.rawText}），该局部标尺段失效`,
        subjectIds: [lo.nominal.id, hi.nominal.id],
        at: hi.band.at ?? undefined,
        validRange: { laneId, sMin: lo.band.s, sMax: hi.band.s, basis: "arc-px" },
      });
      continue;
    }
    pieces.push({
      id: stableId("piece", { laneId, pairingId, lo: lo.nominal.id, hi: hi.nominal.id, loS: lo.band.s, hiS: hi.band.s }),
      laneId,
      loNominalId: lo.nominal.id,
      hiNominalId: hi.nominal.id,
      loBandCenterId: lo.band.id,
      hiBandCenterId: hi.band.id,
      loS: lo.band.s,
      hiS: hi.band.s,
      loQ: lo.nominal.q!,
      hiQ: hi.nominal.q!,
      validSMin: lo.band.s,
      validSMax: hi.band.s,
      unit: lo.nominal.q!.unit,
    });
  }
  return { pieces, nonMonotonic: nonMonotonic };
}

export interface BuildRulerArgs {
  lane: LaneBoundary;
  img: ImageMaterial;
  orientation: OrientationMaterial["orientation"];
  nominals: LadderNominal[];
  bandCenters: BandCenter[];
  ctx: _C;
  digest: InputDigest;
  fitParamId: string;
  parentIds: string[];
}

export function buildRuler(args: BuildRulerArgs): RulerResult {
  const { lane, img, orientation, nominals, bandCenters, digest, fitParamId, parentIds } = args;
  const diagnostics: Diagnostic[] = [];

  const cl = orientPolyline(centerline(lane.left, lane.right), orientation, img.width, img.height);
  const cg = buildPolyline(cl.pts);

  const orderedNoms = [...nominals]
    .filter((x) => x.ladderLaneId === lane.laneId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const nomView: NominalView[] = orderedNoms.map((n) => ({
    id: n.id,
    ordinal: n.ordinal,
    rawText: n.rawText,
    q: n.q,
  }));
  for (const n of orderedNoms) {
    if (!n.q) {
      diagnostics.push({
        code: "UNCONVERTIBLE_VALUE",
        severity: "error",
        message: `ladder 标称“${n.rawText}”无法转换为数值分子量，已保留在原位，不参与标尺`,
        subjectIds: [n.id],
      });
    }
  }

  const bandView: BandView[] = bandCenters
    .filter((b) => b.laneId === lane.laneId)
    .map((b) => {
      const op = orientPoint(b.at, orientation, img.width, img.height);
      return { id: b.id, s: projectToPolyline(cg, op).s, at: op };
    })
    .sort((a, b) => a.s - b.s);

  const numericNoms = nomView.filter((n) => n.q);
  const pairings = enumeratePairings(numericNoms, bandView, 24);
  const pairingCount = pairings.length;
  const match = pairings[0]?.match ?? numericNoms.map(() => -1);

  // ladder 缺带诊断（带位置：挂到相邻已匹配带上）
  match.forEach((j, i) => {
    if (j < 0) {
      const prev = [...match.slice(0, i)].reverse().findIndex((x) => x >= 0);
      const nextJ = match.slice(i + 1).find((x) => x >= 0);
      const anchorIdx = prev >= 0 ? match[i - 1 - prev]! : (nextJ ?? -1);
      const at = anchorIdx >= 0 ? bandView[anchorIdx]?.at ?? undefined : undefined;
      diagnostics.push({
        code: "LADDER_MISSING_BAND",
        severity: pairingCount > 1 ? "warning" : "error",
        message: `ladder 标称 ${numericNoms[i]!.rawText}（第 ${numericNoms[i]!.ordinal} 条）缺少对应条带；${pairingCount > 1 ? `存在 ${pairingCount} 种合法对齐，分子量将保留全部候选` : "按最近合法对齐处理"}`,
        subjectIds: [numericNoms[i]!.id],
        at: at ?? undefined,
      });
    }
  });

  const points: LadderPoint[] = orderedNoms.map((n) => {
    const i = numericNoms.findIndex((x) => x.id === n.id);
    const j = i >= 0 ? match[i]! : -1;
    return {
      nominalId: n.id,
      bandCenterId: j >= 0 ? bandView[j]!.id : null,
      at: j >= 0 ? bandView[j]!.at : null,
      s: j >= 0 ? bandView[j]!.s : null,
      q: n.q,
      rawText: n.rawText,
      ordinal: n.ordinal,
    };
  });

  const invalidNominals = new Set<string>();
  let pieces: RulerPiece[] = [];
  for (let p = 0; p < pairings.length; p++) {
    const built = buildPieces(lane.laneId, numericNoms, bandView, pairings[p]!.match, p, invalidNominals);
    if (p === 0) {
      pieces = built.pieces;
      diagnostics.push(...built.nonMonotonic);
    }
  }

  // 全局对数线性拟合（残差参照）
  const fitPts = points
    .filter((pt) => pt.s !== null && pt.q !== null && !invalidNominals.has(pt.nominalId))
    .map((pt) => ({ s: pt.s as number, lq: Math.log((pt.q as { value: number }).value), nominalId: pt.nominalId, bandCenterId: pt.bandCenterId as string }));
  let globalFit: RulerResult["globalFit"] = null;
  let residuals: RulerResult["residuals"] = [];
  if (fitPts.length >= 2) {
    const ms = fitPts.reduce((a, p) => a + p.s, 0) / fitPts.length;
    const ml = fitPts.reduce((a, p) => a + p.lq, 0) / fitPts.length;
    const den = fitPts.reduce((a, p) => a + (p.s - ms) ** 2, 0);
    const slope = den === 0 ? 0 : fitPts.reduce((a, p) => a + (p.s - ms) * (p.lq - ml), 0) / den;
    const intercept = ml - slope * ms;
    globalFit = { slope, intercept };
    residuals = fitPts.map((p) => {
      const fittedS = (p.lq - intercept) / (slope || Number.EPSILON);
      return { nominalId: p.nominalId, bandCenterId: p.bandCenterId, s: p.s, fittedS, residual: Math.round((p.s - fittedS) * 100) / 100 };
    });
  }

  const id = stableId("ruler", {
    laneId: lane.laneId,
    nominals: orderedNoms.map((n) => n.id),
    bands: bandView.map((b) => b.id),
    fit: fitParamId,
    kernel: KERNEL_VERSION,
  });

  return {
    kind: "ruler",
    id,
    ladderLaneId: lane.laneId,
    points,
    pieces,
    globalFit,
    residuals,
    diagnostics,
    inputDigest: digest,
    paramVersion: fitParamId,
    kernelVersion: KERNEL_VERSION,
    parentIds: [...parentIds, lane.id, fitParamId],
  };
}

/** 供推断层使用：所有合法对齐产生的全部标尺段 */
export function buildAllRulerPieces(args: BuildRulerArgs): { ruler: RulerResult; allPieces: { pairingId: number; pieces: RulerPiece[] }[] } {
  const ruler = buildRuler(args);
  const { lane, img, orientation, nominals, bandCenters } = args;
  const cl = orientPolyline(centerline(lane.left, lane.right), orientation, img.width, img.height);
  const cg = buildPolyline(cl.pts);
  const numericNoms: NominalView[] = [...nominals]
    .filter((x) => x.ladderLaneId === lane.laneId && x.q)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((n) => ({ id: n.id, ordinal: n.ordinal, rawText: n.rawText, q: n.q }));
  const bandView: BandView[] = bandCenters
    .filter((b) => b.laneId === lane.laneId)
    .map((b) => {
      const op = orientPoint(b.at, orientation, img.width, img.height);
      return { id: b.id, s: projectToPolyline(cg, op).s, at: op };
    })
    .sort((a, b) => a.s - b.s);
  const pairings = enumeratePairings(numericNoms, bandView, 24);
  const allPieces = pairings.map((pr, p) => buildPieces(lane.laneId, numericNoms, bandView, pr.match, p, new Set()));
  return { ruler, allPieces };
}
