import type { Quant } from "./types.js";

/**
 * 分子量/长度单位换算到内部规范单位。
 * 无法转换时返回 null，并由调用方在原位置附诊断 —— 绝不为画图丢值。
 */
const MW_TO_DA: Record<string, number> = {
  Da: 1,
  kDa: 1e3,
  kd: 1e3,
};
const LEN_TO_BP: Record<string, number> = {
  bp: 1,
  kb: 1e3,
};

export function toDa(q: Quant): number | null {
  const raw = q.unit.trim();
  if (raw in MW_TO_DA) return q.value * MW_TO_DA[raw]!;
  // 核酸长度单位只在显式标注时换算，不做跨分子类型猜测
  if (raw in LEN_TO_BP) return null;
  return null;
}
export function daToDisplay(da: number): Quant {
  if (da >= 1e3) return { value: round(da / 1e3), unit: "kDa" };
  return { value: round(da), unit: "Da" };
}
export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 校验标称值：必须为正数且自加样端严格递减（同值=非单调错误）。 */
export function monotoneDecreasingDa(bands: { ordinal: number; molecularWeight: Quant }[]):
  | { ok: true; da: number[] }
  | { ok: false; atOrdinal: number; reason: string } {
  const da: number[] = [];
  let prev: number | null = null;
  for (const b of bands) {
    const v = toDa(b.molecularWeight);
    if (v === null) {
      return { ok: false, atOrdinal: b.ordinal, reason: `无法把 ${b.molecularWeight.raw ?? b.molecularWeight.value}${b.molecularWeight.unit} 换算为 Da` };
    }
    if (!(v > 0)) return { ok: false, atOrdinal: b.ordinal, reason: "分子量必须为正" };
    if (prev !== null && v >= prev) {
      return { ok: false, atOrdinal: b.ordinal, reason: "标称值未随迁移严格单调递减（非单调标尺）" };
    }
    da.push(v);
    prev = v;
  }
  return { ok: true, da };
}
