// 离线案例包清单（领域材料，非通用表格）
import type { Material } from '../src/shared/types.js';

export interface ScenarioSpec {
  id: string;
  title: string;
  changesOneSource: string;   // 明确：相对基线只改动的那一个直接来源
  expects: {
    statuses: Record<string, string[]>;
    diagnosticCodes: string[];
    narrative: string;
  };
  // 生成器参数
  render?: { rotate?: 0|90|180|270; smile?: boolean; missingLadderAt?: number[];
            saturateBand?: string; overlapPair?: [string, string]; };
  patch?: {
    kind: 'nonmonotonic-ladder' | 'param-revision' | 'source-patch-band' | 'orientation' | 'curves';
    detail: Record<string, unknown>;
  };
}

export interface CasePack {
  version: string;
  createdAt: string;
  baseline: {
    imageFile: string;
    imageWidth: number;
    imageHeight: number;
    materials: Material[];   // 全部含 provenance 的不可变材料
  };
  scenarios: ScenarioSpec[];
}
