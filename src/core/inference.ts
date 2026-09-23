import { buildPolyline, centerline, orientPoint, orientPolyline, projectToPolyline } from "./geometry.js";
import { stableId } from "./hash.js";
import {
  KERNEL_VERSION,
  type AutoBand,
  type BandMwResult,
  type ComputeContext,
  type InputDigest,
  type MwCandidate,
  type RulerPiece,
} from "./kernel-types.js";
import type {
  BandCenter,
  Diagnostic,
  ImageMaterial,
  LaneBoundary,
  OrientationMaterial,
  Q,
} from "./types.js";

/** 对数线性插值：s(s in [p.loS,p.hiS]) → MW */
function interp(p: RulerPiece, s: number): Q {
  const t = (s - p.loS) / (p.hiS - p.loS || Number.EPSILON);
  const lq = Math.log(p.loQ.value) + t * (Math.log(p.hiQ.value) - Math.log(p.loQ.value));
  return { value: Math.exp(lq), unit: p.unit };
}

function qAt(p: RulerPiece, s: number): Q {
  const t = (s - p.loS) / (p.hiS - p.loS || Number.EPSILON);
  const clamped = Math.max(0, Math.min(1, t));
  const lq = Math.log(p.loQ.value) + clamped * (Math.log(p.hiQ.value) - Math.log(p.loQ.value));
  return { value: Math.exp(lq), unit: p.unit };
}

function pieceFor(pieces: RulerPiece[], s: number): RulerPiece | null {
  for (const p of pieces) {
    if (s >= p.validSMin - 1e-9 && s <= p.validSMax + 1e-9) return p;
  }
  return null;
}

export interface InferArgs {
  lane: LaneBoundary;
  img: ImageMaterial;
  orientation: OrientationMaterial["orientation"];
  autoBands: AutoBand[];
  /** 每个合法 ladder 对齐产生的标尺段集合（缺带时多于一组） */
  pieceSets: { pairingId: number; pieces: RulerPiece[] }[];
  ladderLaneId: string;
  ctx: ComputeContext;
  digest: InputDigest;
  fitParamId: string;
}

/**
 * 核心推断。
 *  - 微笑弯曲：用弧长而非 y，天然做到“同一高度 ≠ 同一分子量”；标尺段只在有效区域内可信。
 *  - 饱和 / 拖尾：中心不可唯一定位 → 给区间。
 *  - 重叠：按各自 FWHM 分裂区间。
 *  - 缺带多对齐：跨全部合法 pieceSet 保留全部合法候选。
 */
export function inferLane(args: InferArgs): BandMwResult[] {
  const { lane, img, orientation, autoBands, pieceSets, digest, fitParamId } = args;
  const cl = orientPolyline(centerline(lane.left, lane.right), orientation, img.width, img.height);
  const cg = buildPolyline(cl.pts);

  return autoBands.map((band) => {
    const diagnostics: Diagnostic[] = [];
    const candidates: MwCandidate[] = [];
    const outOfValidRangeAny: boolean[] = [];

    // 区间端点（弧长）：ok 为单点；饱和按 FWHM；拖尾偏向迁移方向；重叠按 FWHM
    const sCenter = band.peakS;
    let sLo = sCenter;
    let sHi = sCenter;
    let reason: MwCandidate["reason"] = "unique";
    const isSaturated = band.status.includes("saturated");
    const isTailed = band.status === "tailed" || band.status === "saturated+tailed";
    const isOverlapped = band.status === "overlapped" || band.status === "saturated+overlapped";
    if (isSaturated) {
      sLo = sCenter - band.fwhm / 2;
      sHi = sCenter + band.fwhm / 2;
      reason = "saturated-range";
      diagnostics.push({
        code: "SATURATED_BAND",
        severity: "warning",
        message: `泳道 ${lane.label} 弧长 ${Math.round(sCenter)}px 处条带饱和，中心不可定位，仅给出区间候选`,
        subjectIds: [band.id],
        at: band.peakAt,
        validRange: { laneId: lane.laneId, sMin: sLo, sMax: sHi, basis: "arc-px" },
      });
    }
    if (isTailed) {
      sLo = sCenter - band.fwhm / 2;
      sHi = sCenter + band.fwhm * (band.tailAsymmetry ?? 1) / 2;
      if (reason === "unique") reason = "tailed-range";
      diagnostics.push({
        code: "TAILED_BAND",
        severity: "warning",
        message: `条带存在拖尾（不对称度 ${band.tailAsymmetry}），沿迁移方向放宽为区间`,
        subjectIds: [band.id],
        at: band.peakAt,
        validRange: { laneId: lane.laneId, sMin: sLo, sMax: sHi, basis: "arc-px" },
      });
    }
    if (isOverlapped) {
      sLo = sCenter - band.fwhm / 2;
      sHi = sCenter + band.fwhm / 2;
      if (reason === "unique") reason = "overlap-split";
      diagnostics.push({
        code: "OVERLAPPING_BANDS",
        severity: "warning",
        message: `该条带与 ${band.overlapsWith.length} 条相邻条带重叠，仅作为区间候选`,
        subjectIds: [band.id, ...band.overlapsWith],
        at: band.peakAt,
        validRange: { laneId: lane.laneId, sMin: sLo, sMax: sHi, basis: "arc-px" },
      });
    }

    const seen = new Set<string>();
    pieceSets.forEach((set, idx) => {
      const centerPiece = pieceFor(set.pieces, sCenter);
      outOfValidRangeAny.push(centerPiece === null);
      if (!centerPiece) return;
      const qCenter = interp(centerPiece, sCenter);
      let qLo = qCenter;
      let qHi = qCenter;
      let effSLo = sLo;
      let effSHi = sHi;
      if (sLo !== sHi) {
        // 端点若越出该段有效区域，夹到段边界（不做无依据外推）
        effSLo = Math.max(sLo, centerPiece.validSMin);
        effSHi = Math.min(sHi, centerPiece.validSMax);
        qLo = qAt(centerPiece, effSHi); // s 越大 MW 越小
        qHi = qAt(centerPiece, effSLo);
      }
      const key = `${centerPiece.id}:${qLo.value.toFixed(3)}:${qHi.value.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const localReason = pieceSets.length > 1 && idx > 0 ? "multiple-pairings" : reason;
      candidates.push({
        q: qCenter,
        qLo,
        qHi,
        rulerPieceId: centerPiece.id,
        sourceS: sCenter,
        sLo: effSLo,
        sHi: effSHi,
        reason: pieceSets.length > 1 ? localReason : reason,
      });
    });

    // 全部对齐都找不到覆盖该弧长的段 → 超出有效区域
    const outOfRange = candidates.length === 0 && outOfValidRangeAny.every(Boolean);
    if (pieceSets.length > 0 && candidates.length < pieceSets.length && !outOfRange) {
      diagnostics.push({
        code: "MULTIPLE_CANDIDATES",
        severity: "info",
        message: `ladder 缺带导致 ${pieceSets.length} 种合法对齐，保留全部 ${candidates.length} 个候选分子量`,
        subjectIds: [band.id],
      });
    }
    if (candidates.length === 0) {
      diagnostics.push({
        code: outOfRange ? "OUT_OF_VALID_RANGE" : "NO_SOLUTION",
        severity: "error",
        message: outOfRange
          ? `弧长 ${Math.round(sCenter)}px 位于局部标尺有效区域之外，且不允许外推`
          : "没有可覆盖该位置的标尺段，语义无解",
        subjectIds: [band.id],
        at: band.peakAt,
      });
    } else if (outOfValidRangeAny.some(Boolean)) {
      diagnostics.push({
        code: "OUT_OF_VALID_RANGE",
        severity: "warning",
        message: "部分 ladder 对齐下该位置超出有效区域，已只保留落在有效区域内的候选",
        subjectIds: [band.id],
        at: band.peakAt,
      });
    }

    const unique =
      candidates.length === 1 && candidates[0]!.reason === "unique" &&
      candidates[0]!.qLo.value === candidates[0]!.qHi.value;

    const id = stableId("mw", {
      autoBandId: band.id,
      pieces: pieceSets.flatMap((s) => s.pieces.map((p) => p.id)),
      fit: fitParamId,
      kernel: KERNEL_VERSION,
    });

    void cg;
    void orientPoint;
    void projectToPolyline;

    return {
      kind: "bandMw",
      id,
      laneId: lane.laneId,
      autoBandId: band.id,
      bandCenterAt: band.peakAt,
      candidates,
      unique,
      status: band.status,
      outOfValidRange: outOfRange,
      diagnostics,
      inputDigest: digest,
      paramVersion: fitParamId,
      kernelVersion: KERNEL_VERSION,
      parentIds: [band.id, fitParamId],
    };
  });
}
