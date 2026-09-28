import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 内容指纹：相同内容（含父级）在任意机器上得到相同身份 → 等价输入稳定顺序 */
export function contentFingerprint(parts: (string | number | boolean | null)[]): string {
  return sha256Hex(new TextEncoder().encode(parts.map((p) => String(p)).join("\u0001"))).slice(0, 16);
}

export function stableId(prefix: string, parts: (string | number | boolean | null)[]): string {
  return `${prefix}_${contentFingerprint(parts)}`;
}

export function inputSummary(parts: Record<string, unknown>): string {
  const json = JSON.stringify(parts, Object.keys(parts).sort());
  return "sha256:" + sha256Hex(new TextEncoder().encode(json)).slice(0, 24);
}

/** 带命名空间的内容型事件 id（重放时幂等、稳定） */
export function eventId(projectId: string, seq: number, kind: string, payload: unknown): string {
  return stableId("evt", [projectId, seq, kind, JSON.stringify(payload)]);
}
