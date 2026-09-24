import { createHash } from "node:crypto";

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 规范化 JSON：键排序，等价输入得到等价字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** 内容摘要（sha256 截断）。 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 24);
}

/** 材料身份：内容寻址，等价输入得到稳定身份。 */
export function materialId(kind: string, payload: unknown): string {
  return `mat_${digestOf({ kind, payload })}`;
}

/** 派生身份：种类 + 输入摘要 + 参数版本，确定性生成。 */
export function derivedId(kind: string, inputDigest: string, paramVersion: string): string {
  return `drv_${digestOf({ kind, inputDigest, paramVersion })}`;
}

export function decisionId(branchId: string, subjectId: string, action: string, payload: unknown): string {
  return `dec_${digestOf({ branchId, subjectId, action, payload })}`;
}

export function eventId(seq: number, type: string, payload: unknown): string {
  return `evt_${digestOf({ seq, type, payload })}`;
}
