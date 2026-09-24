import type {
  BandMaterial,
  BandResult,
  Diagnostic,
  LaneCalibration
} from "./types.js";
import { contentId } from "./ids.js";
import { findSegment, interpolate, unitOf } from "./calibration.js";

function diag(
  code: Diagnostic["code"],
  severity: Diagnostic["severity"],
  message: string,
  bandId: string,
  laneId: string,
  imageId: string,
  pixel: BandMaterial["center"]["point"]
): Diagnostic {
  return {
    code,
    severity,
    message,
    location: {
      bandId,
      laneId,
      materialId: imageId,
      pixel: { ...pixel }
    }
  };
}

/**
 * 单个条带的分子量推断。
 * - unique：单调插值段内给出唯一值
 * - saturated：中心不确定，只能给区间
 * - tailed：给区间（峰值到拖尾端）
 * - overlap：保留全部合法候选（自身中心 + 重叠伙伴中心）
 * - 落在缺带/非单调区间：invalid，附局部失效原因，不用默认值伪装
 * - 超出有效区域：out_of_range
 */
export function inferBand(
  band: BandMaterial,
  cal: LaneCalibration,
  allowExtrapolation: boolean
): BandResult {
  const diagnostics: Diagnostic[] = [];
  const unit = unitOf(cal);
  const at = (s: number): number => {
    const seg = findSegment(cal, s);
    if (!seg) throw new Error("segment missing within valid range");
    return interpolate(seg, s);
  };
  const segAt = (s: number) => findSegment(cal, s);

  const inInvalidInterval = cal.invalidIntervals.some(
    (iv) => band.s >= iv.sMin && band.s <= iv.sMax
  );
  const centralSeg = segAt(band.s);

  const base = {
    bandId: band.id,
    laneId: band.laneId,
    imageId: band.imageId,
    s: band.s,
    centerPixel: { ...band.center.point },
    anchorIds: [] as string[],
    diagnostics
  };

  const invalidResult = (
    reason: string,
    code: Diagnostic["code"],
    severity: Diagnostic["severity"]
  ): BandResult => {
    diagnostics.push(
      diag(code, severity, reason, band.id, band.laneId, band.imageId, band.center.point)
    );
    return {
      ...base,
      id: contentId(["mwr", band.id, cal.ladderMaterialId, reason, allowExtrapolation]),
      status: "invalid",
      value: null,
      valueLow: null,
      valueHigh: null,
      unit: null,
      segmentId: null,
      validRange: null,
      invalidReason: reason,
      candidates: []
    };
  };

  if (cal.segments.length === 0) {
    return invalidResult(
      "ladder 无有效单调插值段，局部标尺完全失效",
      "ladder_nonmonotonic",
      "error"
    );
  }
  if (inInvalidInterval || !centralSeg) {
    if (band.s < cal.validRange.min || band.s > cal.validRange.max) {
      diagnostics.push(
        diag(
          "out_of_valid_range",
          "warning",
          `条带迁移 s=${band.s.toFixed(1)}px 超出 ladder 有效区域 [${cal.validRange.min.toFixed(
            1
          )}, ${cal.validRange.max.toFixed(1)}]px；allowExtrapolation=${allowExtrapolation}，拒绝外推`,
          band.id,
          band.laneId,
          band.imageId,
          band.center.point
        )
      );
      return {
        ...base,
        id: contentId(["mwr", band.id, cal.ladderMaterialId, "range", allowExtrapolation]),
        status: "out_of_range",
        value: null,
        valueLow: null,
        valueHigh: null,
        unit,
        segmentId: null,
        validRange: cal.validRange,
        invalidReason: "outside_ladder_valid_range",
        candidates: []
      };
    }
    return invalidResult(
      `条带所在 s=${band.s.toFixed(
        1
      )}px 落在缺带/非单调的局部失效区间，无法唯一决定分子量`,
      "ladder_missing_band",
      "error"
    );
  }

  if (band.bandKind === "overlap") {
    // 保留全部合法候选：自身中心 + 重叠伙伴的中心（伙伴由调用方注入到 overlapsWith）
    const candidates: BandResult["candidates"] = [];
    const ownSeg = segAt(band.s);
    if (ownSeg) {
      candidates.push({
        value: interpolate(ownSeg, band.s),
        unit,
        segmentId: ownSeg.id,
        bandId: band.id
      });
    }
    const anchorIds = new Set<string>();
    anchorIds.add(ownSeg?.anchorAId ?? "");
    anchorIds.add(ownSeg?.anchorBId ?? "");
    const partnerIds = band.overlapsWith;
    // 伙伴的 s 通过 sLow/sHigh 无法直接得到，改由上下文注入：见 inferBands
    return {
      ...base,
      id: contentId(["mwr", band.id, cal.ladderMaterialId, "overlap", partnerIds.join("|")]),
      status: "candidate",
      value: null,
      valueLow: null,
      valueHigh: null,
      unit,
      segmentId: ownSeg?.id ?? null,
      validRange: cal.validRange,
      invalidReason: "overlap_unresolved",
      candidates,
      anchorIds: [...anchorIds].filter(Boolean)
    };
  }

  if (band.bandKind === "saturated" || band.bandKind === "tailed") {
    const low = Math.min(band.sLow, band.sHigh, band.s);
    const high = Math.max(band.sLow, band.sHigh, band.s);
    const segLow = segAt(low);
    const segHigh = segAt(high);
    if (!segLow || !segHigh) {
      return invalidResult(
        `${band.bandKind === "saturated" ? "饱和" : "拖尾"}条带的不确定区间跨越失效标尺段`,
        band.bandKind === "saturated" ? "saturated_center" : "tailed_center",
        "error"
      );
    }
    // s 越大分子量越小
    const valueHigh = interpolate(segLow, low);
    const valueLow = interpolate(segHigh, high);
    diagnostics.push(
      diag(
        band.bandKind === "saturated" ? "saturated_center" : "tailed_center",
        "warning",
        `${band.bandKind === "saturated" ? "饱和" : "拖尾"}条带只能标为区间：[${Math.round(
          valueLow
        )}, ${Math.round(valueHigh)}] ${unit}`,
        band.id,
        band.laneId,
        band.imageId,
        band.center.point
      )
    );
    return {
      ...base,
      id: contentId(["mwr", band.id, cal.ladderMaterialId, band.bandKind]),
      status: "interval",
      value: null,
      valueLow,
      valueHigh,
      unit,
      segmentId: segLow.id === segHigh.id ? segLow.id : null,
      validRange: cal.validRange,
      invalidReason: band.bandKind === "saturated" ? "saturated" : "tailed",
      candidates: [
        { value: valueLow, unit, segmentId: segHigh.id, bandId: band.id },
        { value: valueHigh, unit, segmentId: segLow.id, bandId: band.id }
      ],
      anchorIds: [segLow.anchorAId, segLow.anchorBId].filter(
        (id, i, arr) => arr.indexOf(id) === i
      )
    };
  }

  const value = at(band.s);
  const anchorIds = [centralSeg.anchorAId, centralSeg.anchorBId];
  return {
    ...base,
    id: contentId(["mwr", band.id, cal.ladderMaterialId, "unique"]),
    status: "unique",
    value,
    valueLow: value,
    valueHigh: value,
    unit,
    segmentId: centralSeg.id,
    validRange: cal.validRange,
    invalidReason: null,
    candidates: [{ value, unit, segmentId: centralSeg.id, bandId: band.id }],
    anchorIds
  };
}

/** 批量推断：重叠条带注入伙伴候选，保证“无法唯一决定时保留全部合法候选” */
export function inferBands(
  bands: BandMaterial[],
  cal: LaneCalibration,
  allowExtrapolation: boolean
): BandResult[] {
  const byId = new Map(bands.map((b) => [b.id, b]));
  const results = bands.map((band) => {
    if (band.bandKind !== "overlap") return inferBand(band, cal, allowExtrapolation);
    const partnerSs = band.overlapsWith
      .map((id) => byId.get(id)?.s)
      .filter((s): s is number => typeof s === "number");
    const result = inferBand(band, cal, allowExtrapolation);
    const unit = unitOf(cal);
    for (const ps of partnerSs) {
      const seg = findSegment(cal, ps);
      if (seg && !result.candidates.some((c) => c.value === interpolate(seg, ps))) {
        const partnerId = band.overlapsWith.find(
          (id) => Math.abs((byId.get(id)?.s ?? NaN) - ps) < 1e-9
        );
        result.candidates.push({
          value: interpolate(seg, ps),
          unit,
          segmentId: seg.id,
          bandId: partnerId ?? band.id
        });
      }
      if (seg) {
        for (const aid of [seg.anchorAId, seg.anchorBId]) {
          if (!result.anchorIds.includes(aid)) result.anchorIds.push(aid);
        }
      }
    }
    return result;
  });
  return results;
}
