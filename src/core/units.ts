// Every domain quantity carries its unit or coordinate basis.
// Imports keep the ORIGINAL representation; only derived layers normalize.
// Values that cannot be converted stay in place with a diagnostic —
// they are never silently replaced by null or a default.

export type LengthUnit = "px-image";
export type ArcUnit = "px-arc";
export type MassUnit = "bp" | "kb" | "nt";

export interface Quantity<V = number, U extends string = string> {
  value: V;
  unit: U;
  basis?: string; // coordinate frame / reference id, e.g. "image#img_0.rot0"
}

export type LengthPx = Quantity<number, LengthUnit>;
export type ArcPx = Quantity<number, ArcUnit>;

export interface NominalSize {
  raw: string; // original token exactly as imported, e.g. "1.5kb", "500 bp", "N/A"
  normalized?: { value: number; unit: MassUnit };
  diagnostic?: Diagnostic;
}

export type DiagnosticCode =
  | "INCOMPLETE_INPUT"
  | "UNPARSEABLE_UNIT"
  | "NON_MONOTONIC_CALIBRATION"
  | "MISSING_LADDER_BAND"
  | "SATURATED_BAND"
  | "OVERLAPPING_BANDS"
  | "SMEAR"
  | "OUTSIDE_VALID_REGION"
  | "CONFLICTING_DECISIONS"
  | "REVISION_LOCAL_INVALIDATION"
  | "FORMAT_CORRUPT"
  | "SEMANTIC_UNRESOLVABLE"
  | "BUDGET_EXHAUSTED"
  | "COORDINATE_FRAME_MISMATCH";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  // Where the problem lives, in a stable coordinate frame or at a stable id.
  at?: { kind: "pixel" | "material" | "lane" | "band" | "event" | "ruler"; id?: string; x?: number; y?: number; frame?: string };
  related?: string[]; // stable ids of affected objects
}

const MASS_PATTERN = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(bp|kb|nt)\s*$/i;

export function parseNominalSize(raw: unknown): NominalSize {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { raw: String(raw), normalized: { value: raw, unit: "bp" } };
  }
  if (typeof raw !== "string") {
    return {
      raw: String(raw),
      diagnostic: {
        code: "UNPARSEABLE_UNIT",
        message: `标称分子量不是可解析文本: ${String(raw)}`,
      },
    };
  }
  const match = MASS_PATTERN.exec(raw);
  if (!match) {
    return {
      raw,
      diagnostic: {
        code: "UNPARSEABLE_UNIT",
        message: `无法把 "${raw}" 转换为 bp/kb/nt；原值保留在原位置`,
      },
    };
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase() as MassUnit;
  if (value <= 0) {
    return {
      raw,
      diagnostic: { code: "UNPARSEABLE_UNIT", message: `分子量必须为正，得到 ${value}` },
    };
  }
  return { raw, normalized: { value: unit === "kb" ? value * 1000 : value, unit: "bp" } };
}

export function requireComplete<T extends object>(
  value: T,
  required: ReadonlyArray<keyof T>,
  where: { kind: "material" | "lane" | "band" | "event" | "ruler" | "pixel"; id?: string }
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const key of required) {
    const v = value[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      diags.push({
        code: "INCOMPLETE_INPUT",
        message: `字段 ${String(key)} 缺失；不允许用空值或默认值伪装成功`,
        at: { kind: where.kind, id: where.id },
      });
    }
  }
  return diags;
}
