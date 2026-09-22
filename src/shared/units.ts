import type { Diagnostic } from './diagnostic';

/**
 * 领域量携带单位/坐标基准。导入层保留原始表示，
 * 派生层才规范化；无法转换的值留在原位置并附诊断。
 */
export type CoordinateFrame =
  | 'original-pixel' // 原始图像像素坐标（左上角原点，x 右、y 下）
  | 'arc-length' // 沿泳道中心线、自井线起点的弧长（px）
  | 'migration-down'; // 自井线向下的位移（px），未做弯曲校正

export interface PxPoint {
  x: number;
  y: number;
  frame: 'original-pixel';
}

export type Quantity =
  | {
      kind: 'molecular-weight';
      /** 原始表示，导入时不丢失。 */
      raw: string;
      /** 规范化为 bp（核酸）；无法转换时为 null 并附诊断。 */
      bp: number | null;
      unit: 'bp' | 'kbp' | 'unknown';
      diagnostics: Diagnostic[];
    }
  | {
      kind: 'length';
      raw: string;
      px: number | null;
      unit: 'px' | 'mm' | 'cm' | 'unknown';
      diagnostics: Diagnostic[];
    };

const MW_PATTERN = /^\s*([0-9]*\.?[0-9]+)\s*(bp|kbp|kb|k)\s*$/i;
const LEN_PATTERN = /^\s*([0-9]*\.?[0-9]+)\s*(px|mm|cm)\s*$/i;

export function parseMolecularWeight(raw: string): Extract<Quantity, { kind: 'molecular-weight' }> {
  const m = MW_PATTERN.exec(raw);
  if (!m) {
    return {
      kind: 'molecular-weight',
      raw,
      bp: null,
      unit: 'unknown',
      diagnostics: [
        {
          code: 'unconvertible-unit',
          severity: 'error',
          message: `无法将分子量标注 "${raw}" 转换为 bp，保留原始表示`,
        },
      ],
    };
  }
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === 'bp') return { kind: 'molecular-weight', raw, bp: value, unit: 'bp', diagnostics: [] };
  return { kind: 'molecular-weight', raw, bp: value * 1000, unit: 'kbp', diagnostics: [] };
}

export function parseLength(raw: string): Extract<Quantity, { kind: 'length' }> {
  const m = LEN_PATTERN.exec(raw);
  if (!m) {
    return {
      kind: 'length',
      raw,
      px: null,
      unit: 'unknown',
      diagnostics: [
        { code: 'unconvertible-unit', severity: 'error', message: `无法将长度 "${raw}" 转换为 px` },
      ],
    };
  }
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase() as 'px' | 'mm' | 'cm';
  const px = unit === 'px' ? value : unit === 'mm' ? value * 3.7795275591 : value * 37.795275591;
  return { kind: 'length', raw, px, unit, diagnostics: [] };
}

export function bpLabel(bp: number): string {
  return bp >= 1000 ? `${roundTrim(bp / 1000)} kbp` : `${Math.round(bp)} bp`;
}

function roundTrim(v: number): string {
  return `${Math.round(v * 100) / 100}`;
}
