// 领域类型：不可变材料（materials）与可修改决定（decisions）分层。
// 坐标基准：图像像素，原点左上，x 向右，y 向下，单位 px。
// 分子量单位：bp（碱基对），派生层使用 log10(bp) 做插值。

export type Vec = { x: number; y: number };

export const COORD_BASIS = 'image-px:origin-top-left,x-right,y-down' as const;
export const MW_UNIT = 'bp' as const;

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_boundary'
  | 'band_center';

export type PixelSource =
  | { kind: 'image-region'; imageId: string; region: { x: number; y: number; w: number; h: number }; note?: string }
  | { kind: 'image-point'; imageId: string; points: Vec[]; note?: string }
  | { kind: 'derived'; fromMaterialIds: string[]; note?: string };

export type Material = {
  id: string;
  caseId: string;
  kind: MaterialKind;
  version: number;
  content: unknown; // 原始表示，导入时保留，派生层才规范化
  contentHash: string;
  pixelSources: PixelSource[];
  createdSeq: number;
  supersedes: string | null;
};

export type ParamSet = {
  id: string;
  caseId: string;
  version: number;
  content: {
    interpolation: 'log-linear';
    minLadderBands: number;
    saturationGrayLevel: number;
    overlapMinSeparationPx: number;
    budget: { maxOps: number };
  };
  createdSeq: number;
};

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'FORMAT_CORRUPT'
  | 'RESOURCE_EXHAUSTED'
  | 'SEMANTIC_UNSOLVABLE'
  | 'OUT_OF_VALID_REGION'
  | 'SATURATED_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMEARED_BAND'
  | 'NON_MONOTONIC_RULER'
  | 'MISSING_LADDER_BAND'
  | 'LOCAL_INVALIDATION';

export type DiagnosticPosition = {
  caseId: string;
  laneId?: string;
  bandId?: string;
  pixel?: Vec;
  segment?: { lowerPointId: string; upperPointId: string };
  materialId?: string;
};

export type Diagnostic = {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  position: DiagnosticPosition;
};

export type ComputationKind = 'lane_curve_fit' | 'local_ruler' | 'mw_inference';

export type ComputationStatus = 'ok' | 'candidate' | 'interval' | 'diagnostic';

export type Computation = {
  id: string; // 内容寻址：cmp_<hash(kind+subject+inputDigest)>
  caseId: string;
  kind: ComputationKind;
  subject: string; // laneId 或 bandId 或 'global'
  inputDigest: string;
  paramVersion: number;
  parents: string[]; // 父级依赖 computation id
  status: ComputationStatus;
  output: unknown;
  diagnostics: Diagnostic[];
  validFromSeq: number;
  validToSeq: number | null; // 失效事件序号；null = 当前有效
};

export type DecisionAction = 'accept' | 'reject' | 'adjust_param' | 'revise_source';

export type Decision = {
  id: string;
  caseId: string;
  branchId: string; // 冲突的人工决定形成并存分支
  targetKind: 'computation' | 'band' | 'param';
  targetId: string;
  action: DecisionAction;
  payload: unknown;
  reviewer: string;
  note: string;
  createdSeq: number;
};

export type WorkbenchEvent = {
  seq: number;
  id: string;
  caseId: string;
  type:
    | 'import_material'
    | 'compute'
    | 'decision'
    | 'param_revision'
    | 'source_revision'
    | 'local_invalidation'
    | 'judgment'
    | 'export'
    | 'import';
  payload: unknown;
  parents: string[];
  createdAt: string;
};

export type GrayImage = {
  width: number;
  height: number;
  format: 'gray8';
  basis: typeof COORD_BASIS;
  data: Uint8Array;
};

export type ImageContent = {
  width: number;
  height: number;
  format: 'gray8';
  encoding: 'base64';
  basis: typeof COORD_BASIS;
  data: string;
};
