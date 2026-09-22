import type { Diagnostic } from './types';
import { decodePngGray } from './png';

/** 三种彼此不同的失败结果，绝不互相伪装 */
export type ImportFailure =
  | { kind: 'corrupt-format'; diagnostics: Diagnostic[] }
  | { kind: 'resource-exhausted'; diagnostics: Diagnostic[] }
  | { kind: 'semantically-unsolvable'; diagnostics: Diagnostic[] };

export interface ResourceBudget {
  maxImagePixels: number;
  maxArchiveBytes: number;
  maxBandsPerLane: number;
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxImagePixels: 4_000_000,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxBandsPerLane: 200
};

function error(code: string, message: string, path: string, at?: Diagnostic['at']): Diagnostic {
  return { code, message, path, at, severity: 'error' };
}

/** 图像字节校验：先判资源预算，再判格式损坏 */
export function validateImageBytes(
  bytes: Uint8Array,
  budget: ResourceBudget = DEFAULT_BUDGET
):
  | { ok: true; width: number; height: number }
  | { ok: false; failure: ImportFailure } {
  if (bytes.length > budget.maxArchiveBytes) {
    return {
      ok: false,
      failure: {
        kind: 'resource-exhausted',
        diagnostics: [error('IMAGE_TOO_LARGE', '图像字节超出资源预算', 'image.bytes')]
      }
    };
  }
  try {
    const image = decodePngGray(bytes);
    if (image.width * image.height > budget.maxImagePixels) {
      return {
        ok: false,
        failure: {
          kind: 'resource-exhausted',
          diagnostics: [
            error(
              'IMAGE_PIXEL_BUDGET_EXCEEDED',
              `像素数 ${image.width * image.height} 超过预算 ${budget.maxImagePixels}`,
              'image.pixels'
            )
          ]
        }
      };
    }
    return { ok: true, width: image.width, height: image.height };
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : 'PNG_UNKNOWN_ERROR';
    return {
      ok: false,
      failure: {
        kind: 'corrupt-format',
        diagnostics: [error(code, 'PNG 解码失败（格式损坏）', 'image.bytes')]
      }
    };
  }
}

export interface RawLadderValue {
  mwRaw: unknown;
  ordinal: unknown;
}

/**
 * ladder 标称值导入：保留原始表示。
 *  - 无法解析为正有限数 -> 留在原位置的诊断，不丢值、不偷偷用默认值；
 *  - 正序数重复 -> 语义无解；
 *  - 单位缺失 -> 带位置诊断。
 */
export function validateLadder(
  rows: RawLadderValue[],
  unit: string | undefined,
  budget: ResourceBudget = DEFAULT_BUDGET
):
  | { ok: true; values: { mw: number; ordinal: number; raw: string }[]; unit: string }
  | { ok: false; failure: ImportFailure } {
  if (rows.length > budget.maxBandsPerLane) {
    return {
      ok: false,
      failure: {
        kind: 'resource-exhausted',
        diagnostics: [error('LADDER_TOO_MANY_BANDS', 'ladder 标称带数量超过资源预算', 'ladder.bands')]
      }
    };
  }
  const diagnostics: Diagnostic[] = [];
  const values: { mw: number; ordinal: number; raw: string }[] = [];
  if (!unit || !unit.trim()) {
    diagnostics.push(error('LADDER_UNIT_MISSING', 'ladder 缺少单位（bp / kDa）', 'ladder.unit'));
  }
  rows.forEach((row, index) => {
    const raw = typeof row.mwRaw === 'string' ? row.mwRaw : String(row.mwRaw);
    const mw = typeof row.mwRaw === 'number' ? row.mwRaw : Number.parseFloat(raw);
    if (!Number.isFinite(mw) || mw <= 0) {
      diagnostics.push(
        error('LADDER_MW_UNPARSEABLE', `标称分子量无法转换，原值保留在原位置: ${raw}`, `ladder.bands[${index}].mw`, {
          ordinal: index
        })
      );
      return;
    }
    const ordinal = typeof row.ordinal === 'number' ? row.ordinal : Number.parseInt(String(row.ordinal), 10);
    if (!Number.isInteger(ordinal) || ordinal <= 0) {
      diagnostics.push(
        error('LADDER_ORDINAL_INVALID', `标称序数无效: ${String(row.ordinal)}`, `ladder.bands[${index}].ordinal`, {
          ordinal: index
        })
      );
      return;
    }
    values.push({ mw, ordinal, raw });
  });

  const ordinals = values.map((v) => v.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    diagnostics.push(error('LADDER_ORDINAL_DUPLICATE', 'ladder 标称序数重复，语义无解', 'ladder.bands'));
  }
  const unparseable = diagnostics.some((d) => d.code === 'LADDER_MW_UNPARSEABLE' || d.code === 'LADDER_ORDINAL_INVALID');
  if (diagnostics.length > 0) {
    return {
      ok: false,
      failure: {
        kind: unparseable || diagnostics.some((d) => d.code === 'LADDER_ORDINAL_DUPLICATE')
          ? 'semantically-unsolvable'
          : 'corrupt-format',
        diagnostics
      }
    };
  }
  return { ok: true, values: values.sort((a, b) => a.ordinal - b.ordinal), unit: unit as string };
}

/** 像素级来源几何校验：越界、空脊线等带坐标位置返回诊断 */
export function validateGeometry(
  lanes: { ordinal: number; spine: { x: unknown; y: unknown }[] }[],
  width: number,
  height: number
): { ok: true } | { ok: false; failure: ImportFailure } {
  const diagnostics: Diagnostic[] = [];
  lanes.forEach((lane, laneIndex) => {
    if (lane.spine.length < 2) {
      diagnostics.push(
        error('LANE_SPINE_TOO_SHORT', '泳道脊线至少需要 2 个点', `lanes[${laneIndex}].spine`, { lane: lane.ordinal })
      );
    }
    lane.spine.forEach((point, pointIndex) => {
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        diagnostics.push(
          error('LANE_POINT_NON_NUMERIC', '泳道点坐标不是数值', `lanes[${laneIndex}].spine[${pointIndex}]`, {
            lane: lane.ordinal
          })
        );
      } else if (x < 0 || y < 0 || x >= width || y >= height) {
        diagnostics.push(
          error('LANE_POINT_OUT_OF_FRAME', '泳道点越出图像帧', `lanes[${laneIndex}].spine[${pointIndex}]`, {
            x,
            y,
            lane: lane.ordinal
          })
        );
      }
    });
  });
  if (diagnostics.length > 0) {
    return { ok: false, failure: { kind: 'semantically-unsolvable', diagnostics } };
  }
  return { ok: true };
}

/** 输入不完整：返回带位置诊断，绝不用空值/默认值伪装成功 */
export function diagnoseIncomplete(missing: { field: string; at?: Diagnostic['at'] }[]): ImportFailure {
  return {
    kind: 'semantically-unsolvable',
    diagnostics: missing.map((m) =>
      error('INCOMPLETE_INPUT', `输入不完整，缺少 ${m.field}`, m.field, m.at)
    )
  };
}
