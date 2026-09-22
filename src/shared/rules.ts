import type { JudgmentRecord } from './types.ts';

export const RULE_CATALOG: Record<JudgmentRecord['ruleId'], { title: string; statement: string }> = {
  'R-SMILE-LOCAL-RULER': {
    title: '微笑弯曲：局部标尺',
    statement: '泳道弯曲时同一图像高度不代表同一分子量；标尺必须按每条泳道弧长建立并带有效区域。'
  },
  'R-SATURATED-CANDIDATE': {
    title: '饱和条带仅候选',
    statement: '像素达到饱和平台的条带中心不可信，分子量只能标记为候选/区间。'
  },
  'R-TAIL-CANDIDATE': {
    title: '拖尾条带仅候选',
    statement: '显著不对称拖尾使中心定位有偏，分子量只能标记为候选。'
  },
  'R-OVERLAP-INTERVAL': {
    title: '重叠条带保留全部合法候选',
    statement: '两条带重叠且无法唯一解卷积时保留全部合法候选，或给区间，禁止挑选单一值。'
  },
  'R-MISSING-BAND-GAP': {
    title: 'ladder 缺带形成无效间隙',
    statement: '缺失 ladder 标称带导致相邻锚点间阶数不连续，该插值段标记为 gap，其内推断仅候选。'
  },
  'R-NONMONOTONIC-INVALID': {
    title: '非单调标尺段无效',
    statement: '迁移距离与 log(MW) 不满足单调关系的锚点对之间的标尺段无效。'
  },
  'R-REVISION-LOCAL-FAIL': {
    title: '修订后局部失效',
    statement: '人工修订导致的标尺失效必须限制在受影响的局部段/对象，其余区域结论保持有效。'
  },
  'R-EXTRAPOLATION-CANDIDATE': {
    title: '外推仅候选',
    statement: '落在最外锚点之外的样本只能外推，标记为候选并显示有效区域外。'
  },
  'R-UNCALIBRATED': {
    title: '未标定泳道',
    statement: '没有有效 ladder 关联的泳道无法推断分子量。'
  }
};

export function judgment(
  ruleId: JudgmentRecord['ruleId'],
  subjectId: string,
  status: JudgmentRecord['status'],
  evidenceRefs: string[],
  reasonCodes: string[],
  at: string
): JudgmentRecord {
  return { ruleId, subjectId, status, reasonCodes, evidenceRefs, at };
}
