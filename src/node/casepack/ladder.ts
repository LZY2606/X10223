import { stableId } from '../../shared/ids.js';
import { LADDER_NOMINALS_BP } from '../image/render.js';
import type { LadderSpec } from '../../shared/types.js';

export function standardLadder(imageId: string, missingRank?: number): LadderSpec {
  const rawLines = LADDER_NOMINALS_BP.map((v, i) => `${v} bp\t# rank ${i + 1}`).join('\n');
  return {
    id: stableId('ladderspec', imageId, '1kb-v1'),
    unit: 'bp',
    sourceRef: `casepack://ladder-1kb.txt`,
    rawText: rawLines,
    bands: LADDER_NOMINALS_BP.map((v, i) => ({
      nominal: {
        value: v,
        unit: 'bp',
        raw: { number: v, unitText: 'bp', sourceRef: `casepack://ladder-1kb.txt#rank${i + 1}` },
      },
      rank: i + 1,
      present: missingRank === i + 1 ? false : true,
    })),
  };
}

// 非单调 ladder：故意把两个标称交换，造成一段标尺反向
export function nonMonotonicLadder(imageId: string): LadderSpec {
  const base = standardLadder(imageId);
  const bands = base.bands.map((b) => ({ ...b, nominal: { ...b.nominal } }));
  const v4 = bands[3]!.nominal.value;
  const v5 = bands[4]!.nominal.value;
  bands[4]!.nominal.value = v4 + 500; // rank5 标称变得比 rank4 大 ⇒ 非单调
  bands[3]!.nominal.value = v5;
  bands[4]!.nominal.raw = { number: bands[4]!.nominal.value, unitText: 'bp', sourceRef: 'casepack://ladder-corrupt.txt#rank5' };
  bands[3]!.nominal.raw = { number: bands[3]!.nominal.value, unitText: 'bp', sourceRef: 'casepack://ladder-corrupt.txt#rank4' };
  return { ...base, id: stableId('ladderspec', imageId, '1kb-nonmono'), bands, rawText: '篡改标称（非单调）' };
}
