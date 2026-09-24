import type { GelBlueprint } from './gelkit.ts';
import { LADDER_NOMINALS } from './gelkit.ts';

const LADDER_X = 34;
const SAMPLE_XS = [86, 138, 190];
const LANE_LABELS = ['S1', 'S2', 'S3'];

const ladderWithIds = LADDER_NOMINALS.map((l, i) => ({ ...l, id: `n${i}` }));

export const BASELINE_BLUEPRINT: GelBlueprint = {
  variant: 'baseline',
  orientation: 0,
  laneLabels: LANE_LABELS,
  ladderX: LADDER_X,
  sampleXs: SAMPLE_XS,
  curveAmp: 0,
  ladder: ladderWithIds,
  samples: [
    { id: 'b_s1_a', laneLabel: 'S1', y: 78 },
    { id: 'b_s1_b', laneLabel: 'S1', y: 172 },
    { id: 'b_s2_a', laneLabel: 'S2', y: 112 },
    { id: 'b_s3_a', laneLabel: 'S3', y: 205 },
  ],
  exposureMs: 800,
  sensorBits: 12,
  saturationLevel: 4095,
  smears: [],
};

export const SMILE_BLUEPRINT: GelBlueprint = {
  ...BASELINE_BLUEPRINT,
  variant: 'smile_lanes',
  curveAmp: 16,
  samples: [
    { id: 'b_s1_a', laneLabel: 'S1', y: 104 },
    { id: 'b_s2_a', laneLabel: 'S2', y: 104 }, // 与 S1 同一像素高度，但因弯曲弧长不同 ⇒ 分子量不同
    { id: 'b_s3_a', laneLabel: 'S3', y: 198 },
  ],
};

export const SATURATED_BLUEPRINT: GelBlueprint = {
  ...BASELINE_BLUEPRINT,
  variant: 'saturated',
  exposureMs: 2400,
  samples: [
    { id: 'b_s1_a', laneLabel: 'S1', y: 126, status: 'saturated', peak: 1 },
    { id: 'b_s2_a', laneLabel: 'S2', y: 178, status: 'resolved', peak: 0.6 },
  ],
  smears: [{ laneX: 190, startY: 150, endY: 190, peak: 0.3 }],
};

export const OVERLAP_BLUEPRINT: GelBlueprint = {
  ...BASELINE_BLUEPRINT,
  variant: 'overlapping',
  samples: [
    { id: 'b_s1_a', laneLabel: 'S1', y: 120, status: 'overlapped' },
    { id: 'b_s1_b', laneLabel: 'S1', y: 124, status: 'overlapped' }, // 弧距 4px < 6px 阈值
    { id: 'b_s2_a', laneLabel: 'S2', y: 210 },
  ],
};

export const ROTATED_BLUEPRINT: GelBlueprint = {
  ...BASELINE_BLUEPRINT,
  variant: 'rotated_180',
  orientation: 180,
};

export const ALL_BLUEPRINTS = {
  baseline: BASELINE_BLUEPRINT,
  smile_lanes: SMILE_BLUEPRINT,
  saturated: SATURATED_BLUEPRINT,
  overlapping: OVERLAP_BLUEPRINT,
  rotated_180: ROTATED_BLUEPRINT,
};
