import type { RuleVersion } from './types.js';

export const DETECTION_RULE_V1: RuleVersion = {
  id: 'rule_detect_v1',
  family: 'detection',
  version: 1,
  params: {
    laneProjectionThreshold: 0.06,
    minLaneWidthPx: 14,
    peakThreshold: 0.1,
    saturationThreshold: 0.98,
    smearRatio: 1.8,
    minPeakSeparationPx: 6,
    overlapValleyRatio: 0.62,
  },
  note: '列投影找泳道 + 逐行质心跟踪中心线 + 弧长剖面峰检测',
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const DETECTION_RULE_V2: RuleVersion = {
  ...DETECTION_RULE_V1,
  id: 'rule_detect_v2',
  version: 2,
  params: {
    ...DETECTION_RULE_V1.params,
    peakThreshold: 0.08,
    minPeakSeparationPx: 5,
    overlapValleyRatio: 0.58,
  },
  note: '降低峰阈值并收紧峰间距（参数修订后的检测规则）',
  createdAt: '2026-02-01T00:00:00.000Z',
};

export const CALIBRATION_RULE_V1: RuleVersion = {
  id: 'rule_calib_v1',
  family: 'calibration',
  version: 1,
  params: {
    interpolation: 'log10(mw)-linear',
    migrationCoordinate: 'corrected-y',
    localValidRegion: false,
    lateralReachPx: 9999,
  },
  note: '全局标尺：以校正图像 y 坐标作为迁移量，忽略泳道弯曲',
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const CALIBRATION_RULE_V2: RuleVersion = {
  id: 'rule_calib_v2',
  version: 2,
  family: 'calibration',
  params: {
    interpolation: 'log10(mw)-linear',
    migrationCoordinate: 'lane-arc-length',
    localValidRegion: true,
    frontModel: 'linear-between-ladder-lanes',
    disagreementToleranceLog10: 0.08,
  },
  note: '局部标尺：沿弯曲车道弧长 + 双侧 ladder 前沿插值，标尺带有效区域',
  createdAt: '2026-02-01T00:00:00.000Z',
};

export const RULES: Record<string, RuleVersion> = Object.fromEntries(
  [DETECTION_RULE_V1, DETECTION_RULE_V2, CALIBRATION_RULE_V1, CALIBRATION_RULE_V2].map((r) => [r.id, r]),
);
