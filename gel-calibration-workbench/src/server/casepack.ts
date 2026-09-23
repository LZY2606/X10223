import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic, Material, ParamSet } from '../shared/types';
import { sha256Hex } from '../shared/canonical';

export interface CasePack {
  caseId: string;
  manifest: {
    title: string;
    units: Record<string, string>;
    basis: Record<string, string>;
    params: Record<string, ParamSet>;
  };
  materials: Material[];
  narrative: { steps: { kind: string; payload: Record<string, unknown> }[] };
  archive: { variants: VariantDef[] };
  caseDir: string;
}

export interface VariantDef {
  id: string;
  title: string;
  mutation: Record<string, unknown> & { type: string };
  expectation: string;
  judgmentCode: string;
}

// 载入离线案例包。导入时保留原始表示（raw 字段），派生层才做规范化；
// 原图 sha256 在导入时从文件字节计算，作为像素级来源的完整性锚点。
export function loadCasePack(caseDir: string): CasePack {
  const manifest = JSON.parse(readFileSync(join(caseDir, 'manifest.json'), 'utf8'));
  const materialsDoc = JSON.parse(readFileSync(join(caseDir, 'materials.json'), 'utf8'));
  const narrative = JSON.parse(readFileSync(join(caseDir, 'narrative.json'), 'utf8'));
  const archive = JSON.parse(readFileSync(join(caseDir, 'archive.json'), 'utf8'));
  const materials = materialsDoc.materials as Material[];
  for (const m of materials) {
    if (m.kind === 'image') {
      const bytes = readFileSync(join(caseDir, m.file));
      (m as { sha256: string }).sha256 = sha256Hex(bytes);
    }
  }
  return {
    caseId: materialsDoc.caseId,
    manifest: {
      title: manifest.title,
      units: manifest.units,
      basis: manifest.basis,
      params: manifest.params,
    },
    materials,
    narrative,
    archive,
    caseDir,
  };
}

// 导入期校验：输入不完整时返回带位置的诊断，不得用空值或默认值伪装成功。
export function validateMaterials(materials: Material[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const m of materials) {
    if (m.kind === 'ladderSpec') {
      for (const b of m.bands) {
        if (b.sizeBp === null || !(b.sizeBp > 0)) {
          diagnostics.push({
            code: 'VALUE_UNCONVERTIBLE',
            severity: 'warning',
            location: { entity: 'ladderSpec', id: m.id, field: `bands.${b.id}` },
            message: `标称值 "${b.raw}" 无法转换为 bp，保留在原位置；若被 ladder 标记引用将报错`,
          });
        }
      }
    }
    if (m.kind === 'lane' && m.centerline.length < 2) {
      diagnostics.push({
        code: 'INPUT_INCOMPLETE',
        severity: 'error',
        location: { entity: 'lane', id: m.id, field: 'centerline' },
        message: `泳道 ${m.id} 中心线缺失（${m.centerline.length} 点）`,
      });
    }
    if (m.kind === 'bandCenter' && (m.position.x === undefined || m.position.y === undefined)) {
      diagnostics.push({
        code: 'INPUT_INCOMPLETE',
        severity: 'error',
        location: { entity: 'bandCenter', id: m.id, field: 'position' },
        message: `条带 ${m.id} 缺少像素级中心坐标`,
      });
    }
  }
  return diagnostics;
}
