import type { AnalysisResult, Diagnostic, Material, ParamSet } from './types';
import { stableId } from './hash';

/**
 * 反例档案：
 *  1) 保存基线（原图/方向/曝光/标称值/lane/band 的像素级来源全部在 baseline.sources 中）；
 *  2) 每个场景只改动一个直接来源（changedSource），重放分析；
 *  3) 比较结果差异，验证影响是否被限制在 expectedImpact 声明的对象范围内；
 *  4) 同时保留采纳与未采纳结果（adopted 标记），机器可读事件写入 events。
 */

export type ChangeKind =
  | 'rotate-image'
  | 'curved-lane'
  | 'ladder-missing'
  | 'saturated-region'
  | 'overlap-bands'
  | 'nonmonotonic-ruler'
  | 'revision-local-invalidation';

export interface ArchiveEvent {
  id: string;
  at: number;
  change: ChangeKind;
  ruleId:
    | 'SMILE_SAME_HEIGHT_NOT_SAME_MW'
    | 'LOCAL_RULER_NEEDS_VALID_REGION'
    | 'SATURATION_ONLY_CANDIDATE_OR_INTERVAL'
    | 'SMEAR_ONLY_CANDIDATE_OR_INTERVAL'
    | 'OVERLAP_KEEP_ALL_LEGAL_CANDIDATES';
  message: string;
  evidence: { resultId: string; materialId: string | null; diagnosticCode: string | null }[];
}

export interface ScenarioRun {
  id: string;
  change: ChangeKind;
  title: string;
  /** 被改动的唯一直接来源 id 与说明 */
  changedSource: { materialKind: Material['kind']; materialId: string | null; note: string };
  baselineOnly: string[];
  variantOnly: string[];
  /** 结果 id -> {status, adopted, signature}，采纳与未采纳都保留 */
  resultMap: Record<
    string,
    {
      kind: AnalysisResult['kind'];
      status: AnalysisResult['status'];
      adopted: boolean;
      signature: string;
      changed: boolean;
      candidates?: unknown;
    }
  >;
  diagnostics: Diagnostic[];
  events: ArchiveEvent[];
  /** 影响范围是否与预期一致 */
  impactContained: boolean;
  expectedImpact: { include: string[]; exclude: string[] };
}

export interface CounterexampleArchive {
  id: string;
  projectId: string;
  createdAt: number;
  baseline: {
    sourceSummary: Record<string, string>;
    resultIds: string[];
    resultSignatures: Record<string, string>;
    materials: Material[];
    params: ParamSet[];
  };
  scenarios: ScenarioRun[];
}

export interface RunInput {
  change: ChangeKind;
  title: string;
  changedSource: ScenarioRun['changedSource'];
  expectedImpact: ScenarioRun['expectedImpact'];
  materials: Material[];
  params: ParamSet[];
  results: AnalysisResult[];
  /** 已被人工采纳的结果 id 集合 */
  adoptedResultIds: Set<string>;
  rules: { ruleId: ArchiveEvent['ruleId']; message: string; diagnostics: Diagnostic[] }[];
}

export function buildScenario(projectId: string, baseline: CounterexampleArchive['baseline'], input: RunInput, seq: number): ScenarioRun {
  const baseIds = new Set(baseline.resultIds);
  const varResults = input.results;
  const varIds = new Set(varResults.map((r) => r.id));

  const resultMap: ScenarioRun['resultMap'] = {};
  for (const result of varResults) {
    const sig = resultSignature(result);
    resultMap[result.id] = {
      kind: result.kind,
      status: result.status,
      adopted: input.adoptedResultIds.has(result.id),
      signature: sig,
      changed: !baseIds.has(result.id) || baseline.resultSignatures[result.id] !== sig,
      candidates: result.kind === 'mwInference' ? result.candidates : undefined
    };
  }

  const events: ArchiveEvent[] = input.rules.map((rule, i) => ({
    id: stableId('ae', [projectId, input.change, seq, i, rule.message]),
    at: 0,
    change: input.change,
    ruleId: rule.ruleId,
    message: rule.message,
    evidence: rule.diagnostics.slice(0, 8).map((d) => ({
      resultId: '',
      materialId: d.location?.kind === 'material' ? d.location.materialId : null,
      diagnosticCode: d.code
    }))
  }));

  const changedIds = Object.entries(resultMap)
    .filter(([, v]) => v.changed)
    .map(([id]) => id);
  const includeOk = input.expectedImpact.include.every((token) => changedIds.some((id) => id.includes(token)) || matchesRule(events, token));
  const excludeOk = input.expectedImpact.exclude.every((token) => !changedIds.some((id) => id.includes(token)));

  return {
    id: stableId('sc', [projectId, input.change]),
    change: input.change,
    title: input.title,
    changedSource: input.changedSource,
    baselineOnly: baseline.resultIds.filter((id) => !varIds.has(id)),
    variantOnly: varResults.filter((r) => !baseIds.has(r.id)).map((r) => r.id),
    resultMap,
    diagnostics: input.results.flatMap((r) => ('diagnostics' in r ? r.diagnostics : [])),
    events,
    impactContained: includeOk && excludeOk,
    expectedImpact: input.expectedImpact
  };
}

function matchesRule(events: ArchiveEvent[], token: string): boolean {
  return events.some((e) => e.ruleId.includes(token) || e.message.includes(token));
}

export function resultSignature(result: AnalysisResult): string {
  if (result.kind === 'mwInference') {
    return stableId('sig', [
      result.status,
      result.candidates.map((c) => [c.kind, c.mass, c.low ?? null, c.high ?? null, c.segmentId])
    ]);
  }
  if (result.kind === 'ladderCalibration') {
    return stableId('sig', [
      result.status,
      result.validTRange,
      result.segments.map((s) => [s.id, s.valid])
    ]);
  }
  if (result.kind === 'laneProjection') {
    return stableId('sig', [result.status, result.bandProjection.map((b) => [b.bandId, Math.round(b.t * 100)])]);
  }
  return stableId('sig', [result.status, result.kind]);
}

/** 等价输入 => 稳定顺序：按固定键排序的结果 id 序列 */
export function stableOrdering(results: AnalysisResult[]): string[] {
  return [...results]
    .sort((a, b) => {
      const ka = `${a.kind}:${(a as { laneId?: string; bandId?: string }).laneId ?? ''}:${(a as { bandId?: string }).bandId ?? ''}`;
      const kb = `${b.kind}:${(b as { laneId?: string; bandId?: string }).laneId ?? ''}:${(b as { bandId?: string }).bandId ?? ''}`;
      return ka.localeCompare(kb);
    })
    .map((r) => r.id);
}
