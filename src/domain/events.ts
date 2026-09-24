/** Machine-readable event log. Every computed result records input digest,
 *  parameter version and parent dependencies. */

export interface GelEvent {
  id: string;
  seq: number;
  type: string;
  branch: string;
  payload: unknown;
  parents: string[];
  inputDigest: string;
  paramVersion: string;
  createdAt: string;
}

export type DecisionAction = 'accept' | 'reject' | 'adjust';

export interface DecisionPayload {
  bandKey: string;
  estimateId: string;
  action: DecisionAction;
  rationale: string;
  candidateIndex?: number;
  reviewer: string;
}

export interface JudgmentPayload {
  principle: string;
  statement: string;
  evidence: unknown;
}
