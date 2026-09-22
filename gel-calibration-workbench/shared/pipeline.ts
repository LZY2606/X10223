import type {
  BandMark,
  CalibrationParams,
  DerivedNode,
  Diagnostic,
  ImageMaterial,
  LadderSpec,
  LaneGeometry,
  Material,
} from './types.js';
import { buildCalibration, inferBands } from './calibration.js';
import { canonicalJson, combine, METHOD_VERSION, PARAMS_SCHEMA_VERSION, stableId } from './ids.js';

export interface PipelineInputs {
  image: ImageMaterial;
  ladderSpec: LadderSpec;
  lanes: LaneGeometry[];
  bands: BandMark[];
  /** 哪条泳道承载 ladder */
  ladderLaneIndex: number;
}

export class BudgetExhausted extends Error {
  code = 'RESOURCE_BUDGET_EXHAUSTED' as const;
}

export interface PipelineResult {
  node: DerivedNode;
  /** 与该节点关联的结构化判定事件载荷（机器可读） */
  evidenceEvents: EvidenceJudgement[];
}

export interface EvidenceJudgement {
  rule: string;
  status: 'accepted' | 'candidate-only' | 'interval-only' | 'failed';
  affected: string[];
  validRegion?: { minArcPx: number; maxArcPx: number };
  reason: string;
}

/**
 * 运行分子量推断管线。纯函数：服务端/存储层/测试直接调用，不依赖浏览器。
 * 资源预算、格式损坏、语义无解在调用层与结果层区分成三种不同结果。
 */
export function runPipeline(
  inputs: PipelineInputs,
  params: CalibrationParams,
  parentDerivedId: string | null,
  budget = 200_000,
): PipelineResult {
  const start = budget;
  let spent = 0;
  const tick = (cost: number) => {
    spent += cost;
    if (spent > start) throw new BudgetExhausted(`计算预算耗尽：${spent} > ${start}`);
  };

  tick(inputs.lanes.length * 200 + inputs.bands.length * 400);

  const materialIds = [
    inputs.image.id,
    inputs.ladderSpec.id,
    ...inputs.lanes.map((l) => l.id),
    ...inputs.bands.map((b) => b.id),
  ].sort();
  const shaParts = materialIds;
  const fingerprint = combine([
    canonicalJson(materialIds),
    params.id,
    PARAMS_SCHEMA_VERSION,
    METHOD_VERSION,
  ]);
  const digest = {
    materialIds,
    shaParts,
    paramsId: params.id,
    fingerprint,
  };

  const ladderLane = inputs.lanes.find((l) => l.laneIndex === inputs.ladderLaneIndex) ?? null;
  const ladderBands = inputs.bands.filter((b) => b.laneGeometryId === ladderLane?.id);
  const cal = ladderLane
    ? buildCalibration(inputs.ladderSpec, ladderLane, ladderBands)
    : { points: [], segments: [], diagnostics: [] as Diagnostic[] };

  tick(cal.segments.length * 300);

  const bandsOut = inputs.lanes.flatMap((lane) => {
    if (lane === ladderLane) return [];
    const laneBands = inputs.bands.filter((b) => b.laneGeometryId === lane.id);
    return inferBands(lane, laneBands, cal, params, { fingerprintPrefix: fingerprint });
  });
  tick(bandsOut.length * 500);

  const diagnostics = [...cal.diagnostics, ...bandsOut.flatMap((b) => b.diagnostics)];
  const evidenceEvents = buildEvidenceEvents(cal, bandsOut);

  const outcome: DerivedNode['outcome'] = diagnostics.some(
    (d) => d.code === 'SEMANTIC_NO_SOLUTION',
  )
    ? 'SEMANTIC_NO_SOLUTION'
    : 'ok';

  const node: DerivedNode = {
    kind: 'derived',
    id: stableId('derived', digest),
    caseId: inputs.image.caseId,
    inputDigest: digest,
    parentDerivedId,
    ladderLaneGeometryId: ladderLane?.id ?? null,
    ladderPoints: cal.points,
    segments: cal.segments,
    bands: bandsOut,
    diagnostics,
    outcome,
    budget: { budget: start, spent, exhausted: false },
    createdAt: new Date(0).toISOString(),
  };
  return { node, evidenceEvents };
}

function buildEvidenceEvents(
  cal: ReturnType<typeof buildCalibration>,
  bands: ReturnType<typeof inferBands> extends infer _ ? any[] : never,
): EvidenceJudgement[] {
  const events: EvidenceJudgement[] = [];
  for (const seg of cal.segments) {
    events.push({
      rule: 'local-calibration-valid-region',
      status: seg.monotonic ? 'accepted' : 'failed',
      affected: [`segment:${seg.index}`, seg.from.bandMarkId, seg.to.bandMarkId],
      validRegion: {
        minArcPx: seg.validArcRange.min,
        maxArcPx: seg.validArcRange.max,
      },
      reason: seg.monotonic
        ? '局部标尺段有效区域已记录；仅该弧长区间内可插值分子量'
        : '非单调标尺段失效：同一弧长可能对应两个分子量',
    });
    if (seg.spansGap) {
      events.push({
        rule: 'ladder-missing-band-gap',
        status: 'interval-only',
        affected: [`segment:${seg.index}`],
        validRegion: { minArcPx: seg.validArcRange.min, maxArcPx: seg.validArcRange.max },
        reason: 'ladder 缺带：跨缺口只能给出区间候选',
      });
    }
  }
  for (const b of bands as {
    status: string;
    bandMarkId: string;
    evidenceSegmentIndex: number | null;
  }[]) {
    if (b.status === 'interval-only' || b.status === 'candidate-set') {
      events.push({
        rule:
          b.status === 'candidate-set'
            ? 'overlap-all-candidates'
            : 'uncertain-band-interval-only',
        status: b.status === 'candidate-set' ? 'candidate-only' : 'interval-only',
        affected: [b.bandMarkId],
        reason:
          b.status === 'candidate-set'
            ? '两条带重叠：保留全部合法候选，等待人工决定，不擅自唯一化'
            : '饱和条带/拖尾只能标为候选或区间',
      });
    }
  }
  return events;
}

/** 输入完整性：不完整输入 → 带位置诊断，绝不以空值/默认值伪装成功 */
export function validateInputs(inputs: Partial<PipelineInputs> | null): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (!inputs) {
    diags.push({
      code: 'FORMAT_CORRUPT',
      message: '管线输入为空',
      location: { kind: 'document', path: '$' },
      reason: 'null-input',
    });
    return diags;
  }
  if (!inputs.image)
    diags.push({ code: 'FORMAT_CORRUPT', message: '缺少原图材料', location: { kind: 'image' }, reason: 'missing-image' });
  if (!inputs.ladderSpec)
    diags.push({
      code: 'FORMAT_CORRUPT',
      message: '缺少 ladder 标称值',
      location: { kind: 'document', path: '$.ladderSpec' },
      reason: 'missing-ladder-spec',
    });
  if (!inputs.lanes?.length)
    diags.push({
      code: 'SEMANTIC_NO_SOLUTION',
      message: '缺少 lane 边界',
      location: { kind: 'document', path: '$.lanes' },
      reason: 'missing-lanes',
    });
  if (inputs.image && inputs.image.reviewedOrientationDeg === null)
    diags.push({
      code: 'SEMANTIC_NO_SOLUTION',
      message: '拍摄方向尚未人工核对：不得用默认方向继续',
      location: { kind: 'image' },
      reason: 'orientation-not-reviewed',
    });
  return diags;
}

export function materialSummary(m: Material): string {
  return `${m.kind}:${m.id}`;
}
