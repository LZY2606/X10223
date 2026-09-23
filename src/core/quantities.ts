import type { Q, Unit } from "./types.js";

/**
 * 规范化分子量。导入层只解析、不丢弃：
 *  - "1500 bp" / "1.5 kb" / "500bp" → bp
 *  - "35 kDa" / "35000 Da" → kDa（分子量单位）
 *  - "对照" / "??" / "" 等 → null，原值保留在原位
 */
export function parseMolecularWeight(rawText: string): { q: Q | null; issue?: string } {
  const raw = rawText.trim();
  if (raw === "") return { q: null, issue: "空标称值" };
  const m = raw.match(/^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([kKmMuU]?)(?:bp|BP|b\.p\.|Da|da|kDa|KDa|kda|KD|kd)?\s*$/);
  if (!m) {
    // 中文 / 无法识别的原始文本：保留，不做规范化
    return { q: null, issue: `无法将“${raw}”转换为数值分子量` };
  }
  const num = Number(m[1]);
  const prefix = m[2] ?? "";
  if (!Number.isFinite(num) || num <= 0) return { q: null, issue: `分子量必须为正数：${raw}` };
  const lower = raw.toLowerCase();
  if (lower.includes("da") && !lower.includes("bp")) {
    let value = num;
    const unit: Unit = "kDa";
    if (prefix.toLowerCase() === "k") value = num; // 已为 kDa
    else value = num / 1000; // Da → kDa
    return { q: { value, unit } };
  }
  // 默认 bp
  let value = num;
  if (prefix.toLowerCase() === "k") value = num * 1000;
  if (prefix.toLowerCase() === "m") value = num * 1_000_000;
  return { q: { value, unit: "bp" } };
}

export function formatQ(q: Q): string {
  if (q.unit === "bp") return `${formatNum(q.value)} bp`;
  return `${formatNum(q.value)} kDa`;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toPrecision(4);
}
