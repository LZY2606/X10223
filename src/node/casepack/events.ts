// 确定性事件工厂：lineSeq 等价输入稳定顺序，时间戳为固定 ISO 时间（导入保留原始表示）。
import { stableId } from '../../shared/ids.js';
import type {
  Decision,
  EventKind,
  FindingPayload,
  ProjectEvent,
} from '../../shared/types.js';

const EPOCH = '2026-09-19T00:00:00.000Z';

function atTime(lineSeq: number): string {
  const t = new Date(EPOCH).getTime() + lineSeq * 60_000;
  return new Date(t).toISOString();
}

export class EventWriter {
  private seqByBranch = new Map<string, number>();
  private line = 0;

  next(
    projectId: string,
    branchId: string,
    kind: EventKind,
    payload: unknown,
    opts: {
      parents?: string[];
      paramsVersion?: string;
      inputSummary?: string;
      findings?: FindingPayload[];
      idKey?: string;
      author?: string;
    } = {},
  ): ProjectEvent {
    const seq = (this.seqByBranch.get(branchId) ?? 0) + 1;
    this.seqByBranch.set(branchId, seq);
    const lineSeq = this.line++;
    const id = stableId('evt', projectId, branchId, seq, opts.idKey ?? kind);
    return {
      id,
      projectId,
      branchId,
      seq,
      lineSeq,
      kind,
      timestamp: atTime(lineSeq),
      parentEventIds: opts.parents ?? [],
      inputSummary: opts.inputSummary ?? '',
      paramsVersion: opts.paramsVersion,
      payload,
      findings: opts.findings,
      author: opts.author ?? 'casepack',
    };
  }

  get lineCount(): number {
    return this.line;
  }
}

export function decisionEvent(
  verb: Decision['verb'],
  subjectType: Decision['subjectType'],
  subjectId: string,
  extra: Partial<Decision> = {},
): Decision {
  return { verb, subjectType, subjectId, ...extra };
}
