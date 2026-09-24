import type { Diagnostic } from './units';
import type { MwEstimate } from './estimates';
import type { GelEvent } from './events';

/** Counterexample archive entry: baseline digest + exactly one mutated direct source.
 *  Adopted and non-adopted results are both preserved. */
export interface ArchiveEntry {
  id: string;
  seq: number;
  title: string;
  mutatedSource: string;
  baselineDigest: string;
  affected: string[];
  adopted: MwEstimate[];
  rejected: { estimate: MwEstimate; reason: string }[];
  diagnostics: Diagnostic[];
  judgments: GelEvent[];
}

export const PRINCIPLE_SMILE = 'smile-local-ruler';
export const PRINCIPLE_CANDIDATE_ONLY = 'saturation-overlap-candidate-only';

export const STATEMENT_SMILE = '“微笑”弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域';
export const STATEMENT_CANDIDATE_ONLY = '饱和条带、拖尾和重叠只能标为候选或区间';
