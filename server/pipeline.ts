import { DEFAULT_BUDGET } from '../shared/types';
import type {
  Budget,
  Decision,
  EngineParams,
  GelEvent,
  Material,
  PipelineResult,
} from '../shared/types';
import { applyDecisions, runPipeline } from './engine';
import type { GelStore } from './store';

// 编排层：每次计算都留下事件（输入摘要、参数版本、父级依赖）与不可变快照。
// 回到任意旧事件 = 读当时的快照，绝不用最新计算覆盖历史。

export function computeAndStore(
  store: GelStore,
  materials: Material[],
  params: EngineParams,
  parents: string[],
  branch: string,
  budget: Budget = DEFAULT_BUDGET,
): { event: GelEvent; result: PipelineResult } {
  const result = runPipeline(materials, params, budget);
  const event = store.appendEvent(
    'compute',
    {
      computationId: result.computationId,
      status: result.status,
      materialIds: result.materialIds,
      method: params.method,
    },
    parents,
    result.inputDigest,
    params.paramVersion,
    branch,
  );
  store.saveComputation(result, event.id);
  const decisions = store.listDecisions(event.seq);
  store.saveSnapshot({
    eventId: event.id,
    computationId: result.computationId,
    view: applyDecisions(result, decisions),
    decisions,
  });
  return { event, result };
}

export function decideAndStore(
  store: GelStore,
  input: {
    laneId: string;
    bandKey: string;
    kind: Decision['kind'];
    optionMw?: number;
    branch: string;
    computationId: string;
    note?: string;
  },
): { event: GelEvent; decision: Decision } {
  const computation = store.getComputation(input.computationId);
  if (!computation) throw new Error(`computation not found: ${input.computationId}`);
  const event = store.appendEvent(
    'decision',
    {
      laneId: input.laneId,
      bandKey: input.bandKey,
      decisionKind: input.kind,
      optionMw: input.optionMw ?? null,
      computationId: input.computationId,
      note: input.note ?? null,
    },
    [],
    computation.inputDigest,
    computation.paramVersion,
    input.branch,
  );
  const decision = store.addDecision(
    event.id,
    input.laneId,
    input.bandKey,
    input.kind,
    input.optionMw ?? null,
    input.branch,
  );
  const decisions = store.listDecisions(event.seq);
  store.saveSnapshot({
    eventId: event.id,
    computationId: computation.computationId,
    view: applyDecisions(computation, decisions),
    decisions,
  });
  return { event, decision };
}

export function judgmentAndStore(
  store: GelStore,
  payload: Record<string, unknown>,
  parents: string[],
  branch: string,
): GelEvent {
  return store.appendEvent('judgment', payload, parents, '', 'judgment/1.0', branch);
}
