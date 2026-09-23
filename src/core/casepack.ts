import { encodePng } from './png'
import { curvedSpine, renderGel, straightSpine, type GelSpec, type RenderedBand } from './gelgen'
import type { PointXY } from '../shared/types'

export type ScenarioKind =
  | 'baseline'
  | 'rotation'
  | 'curved_lanes'
  | 'ladder_missing'
  | 'saturation'
  | 'overlap'
  | 'nonmonotonic'
  | 'revision_local_failure'

export interface ScenarioExpectation {
  /** 机读判定事件：系统应给出的结构化状态。 */
  code: string
  state?: 'unique' | 'candidates' | 'interval' | 'invalid'
  laneId?: string
  bandKey?: { lane: number; r: number }
  message: string
  adopted: boolean
}

export interface Scenario {
  kind: ScenarioKind
  title: string
  description: string
  width: number
  height: number
  png: Uint8Array
  rotationDeg: 0 | 90 | 180 | 270
  exposureMs: number
  saturationGray: number
  laneLabels: { laneId: string; isLadder: boolean }[]
  ladder: { slot: number; nominalBp: number; raw: string; declaredMissing?: boolean }[]
  /** 真值折线（像素坐标）。 */
  spineTruth: PointXY[][]
  /** 真值带（归一化 r）。 */
  bandsTruth: RenderedBand[]
  expectations: ScenarioExpectation[]
  /** 非单调场景的“改动后”标称序列（直接来源改动）。 */
  nonmonotonicLadder?: number[]
}

const W = 900
const H = 760
const Y0 = 70
const Y1 = 700
const LANE_COUNT = 6
const LANE_XS = [120, 250, 380, 510, 640, 770]

// 常见 100bp 梯度（自上而下：大 -> 小）
const LADDER = [1500, 1000, 750, 500, 250, 100]
const LADDER_R = [0.12, 0.24, 0.35, 0.5, 0.7, 0.9]

function laneIds(): { laneId: string; isLadder: boolean }[] {
  return LANE_XS.map((_, i) => ({ laneId: `lane_${i + 1}`, isLadder: i === 0 }))
}

function ladderSpec(declaredMissingSlots: number[] = []): { slot: number; nominalBp: number; raw: string; declaredMissing?: boolean }[] {
  return LADDER.map((bp, i) => ({
    slot: i + 1,
    nominalBp: bp,
    raw: `${bp} bp`,
    declaredMissing: declaredMissingSlots.includes(i + 1) ? true : undefined
  }))
}

function sampleBands(overlap = false, saturatedLane = -1, smearLane = -1): GelSpec['bands'] {
  const bands: GelSpec['bands'] = []
  // lane 0 = ladder
  LADDER_R.forEach((r, i) => bands.push({ lane: 0, r, amp: 200 }))
  // 样本道
  const sample: Record<number, { r: number; amp: number; smear?: number }[]> = {
    1: [
      { r: 0.24, amp: 200 },
      { r: 0.5, amp: 170 },
      { r: 0.78, amp: 150 }
    ],
    2: [
      { r: 0.18, amp: 190 },
      { r: 0.56, amp: 160 }
    ],
    3: [
      { r: 0.3, amp: 180 },
      { r: 0.66, amp: 150 }
    ],
    4: [
      { r: 0.4, amp: 175 },
      { r: 0.85, amp: 140 }
    ],
    5: [
      { r: 0.22, amp: 185 },
      { r: 0.6, amp: 160 }
    ]
  }
  for (const [laneStr, arr] of Object.entries(sample)) {
    const lane = Number(laneStr)
    for (const b of arr) {
      const amp = lane === saturatedLane ? 255 : b.amp
      bands.push({ lane, r: b.r, amp, smear: lane === smearLane ? 26 : undefined })
    }
  }
  if (overlap) {
    // 两条带重叠：r 极近，合并不掉
    bands.push({ lane: 5, r: 0.226, amp: 150 })
  }
  if (saturatedLane >= 0) {
    bands.push({ lane: saturatedLane, r: 0.52, amp: 255 })
  }
  return bands
}

function build(
  kind: ScenarioKind,
  title: string,
  description: string,
  spines: PointXY[][],
  bands: GelSpec['bands'],
  expectations: ScenarioExpectation[],
  extra: Partial<Pick<Scenario, 'rotationDeg' | 'ladder' | 'nonmonotonicLadder' | 'saturationGray' | 'exposureMs'>> = {}
): Scenario {
  const rendered = renderGel({ width: W, height: H, spines, bands, drawEnds: true, seed: 42 + kind.length })
  return {
    kind,
    title,
    description,
    width: W,
    height: H,
    png: encodePng(rendered),
    rotationDeg: extra.rotationDeg ?? 0,
    exposureMs: extra.exposureMs ?? 2000,
    saturationGray: extra.saturationGray ?? 245,
    laneLabels: laneIds(),
    ladder: extra.ladder ?? ladderSpec(),
    spineTruth: spines,
    bandsTruth: rendered.rendered,
    expectations,
    nonmonotonicLadder: extra.nonmonotonicLadder
  }
}

function straightSpines(): PointXY[][] {
  return LANE_XS.map((x) => straightSpine(x, Y0, Y1))
}
function curvedSpines(bendAmp: number, edgeSmile: number): PointXY[][] {
  return LANE_XS.map((x, i) => {
    const edge = i === 0 || i === LANE_COUNT - 1 ? 1 : 0
    return curvedSpine(x, Y0, Y1, i % 2 === 1 ? bendAmp : -bendAmp * 0.6, edgeSmile * edge, 40)
  })
}

export function buildCasepack(): { format: string; generatedAt: string; scenarios: Scenario[] } {
  const scenarios: Scenario[] = []

  // 1. 基线：全部来源完整、直道、无病态
  scenarios.push(
    build(
      'baseline',
      '基线：像素级来源完整的正常胶',
      '原图、拍摄方向、曝光、ladder 标称、lane 边界、条带中心全部保留像素级来源。',
      straightSpines(),
      sampleBands(),
      [
        { code: 'unique', state: 'unique', laneId: 'lane_2', message: '样本带给出唯一分子量并可回溯到插值段', adopted: true },
        { code: 'calibration_ok', message: 'ladder 单调、分段标尺建立成功', adopted: true }
      ]
    )
  )

  // 2. 旋转图像：只改拍摄方向这一直接来源（图顺时针拍歪 90，声明旋转恢复）
  scenarios.push(
    build(
      'rotation',
      '反例：拍摄方向旋转 90°',
      '只改动拍摄方向：原始 PNG 被顺时针旋转 90° 拍摄，必须声明 rotationDeg 恢复迁移向下，影响被限制在坐标基准层。',
      straightSpines(),
      sampleBands(),
      [
        { code: 'orientation_recovered', message: '应用 90° 旋转后坐标基准切换到 oriented_image，分子量与基线一致', adopted: true },
        { code: 'basis_isolation', message: '旋转只改变坐标基准，标称值与弧长结论不变', adopted: true }
      ],
      { rotationDeg: 90 }
    )
  )

  // 3. 弯曲泳道：微笑，同一像素高度 != 同一分子量
  scenarios.push(
    build(
      'curved_lanes',
      '反例：“微笑”弯曲泳道',
      '泳道呈弯曲；同一像素 y 的两条带分子量不同。必须沿 lane 曲线弧长归一化，局部标尺带有效区域。',
      curvedSpines(34, 18),
      sampleBands(),
      [
        { code: 'curved_lanes', message: '检测到多段折线泳道，弧长投影校正弯曲', adopted: true },
        { code: 'local_valid_region', message: '局部标尺仅在 ladder 覆盖的 r 区间有效，区间外返回失效不外推', adopted: true },
        { code: 'height_not_mw', message: '同一像素高度不等于同一分子量，按相对迁移 r 对齐', adopted: true }
      ]
    )
  )

  // 4. ladder 缺带
  scenarios.push(
    build(
      'ladder_missing',
      '反例：ladder 缺带',
      'ladder 第 4 槽（500bp）缺带；对齐须跳过该槽，缺带两侧分段插值，缺带点不参与拟合。',
      straightSpines(),
      // 移除 ladder r=0.5 那条
      sampleBands().filter((b) => !(b.lane === 0 && Math.abs(b.r - 0.5) < 0.01)),
      [
        { code: 'ladder_missing_bands', message: '存在缺失标称带，缺带点不参与拟合', adopted: true },
        { code: 'piecewise_segment', message: '缺带两侧仍可分段插值，受影响段被标记', adopted: true }
      ],
      { ladder: ladderSpec([4]) }
    )
  )

  // 5. 饱和区
  scenarios.push(
    build(
      'saturation',
      '反例：饱和条带',
      'lane_3 两条带峰被削平（255）；饱和带只能标为候选或区间，不给唯一断言。',
      straightSpines(),
      sampleBands(false, 3, -1),
      [
        { code: 'saturated_band', state: 'interval', laneId: 'lane_4', message: '饱和像素比例超限，峰值削平，只能给区间', adopted: true },
        { code: 'unsaturated_unaffected', message: '未饱和泳道结论不受影响（影响范围受限）', adopted: true }
      ]
    )
  )

  // 6. 两条带重叠
  scenarios.push(
    build(
      'overlap',
      '反例：两条带重叠',
      'lane_6 两条带迁移极近发生重叠；无法唯一决定时保留全部合法候选。',
      straightSpines(),
      sampleBands(true),
      [
        { code: 'overlap', state: 'candidates', laneId: 'lane_6', message: '重叠带保留全部合法候选，不做单点断言', adopted: true },
        { code: 'nonoverlap_unaffected', message: '其他泳道唯一结论不受影响', adopted: true }
      ]
    )
  )

  // 7. 非单调标尺
  scenarios.push(
    build(
      'nonmonotonic',
      '反例：非单调 ladder 标尺',
      '只改动 ladder 标称值这一直接来源：标称序列出现违背“迁移越大分子量越小”的倒置，标尺语义无解。',
      straightSpines(),
      sampleBands(),
      [
        { code: 'nonmonotonic_ladder', state: 'invalid', message: '标称值非单调，标尺语义无解，相关分子量全部 invalid', adopted: true },
        { code: 'semantic_vs_corrupt', message: '这是语义无解而非格式损坏，输入片段被保留', adopted: true }
      ],
      { nonmonotonicLadder: [1500, 1000, 1200, 500, 250, 100], ladder: [1500, 1000, 1200, 500, 250, 100].map((bp, i) => ({ slot: i + 1, nominalBp: bp, raw: `${bp} bp` })) }
    )
  )

  // 8. 修订后局部失效：基线基础上移动一条样本带（只影响该带依赖）
  scenarios.push(
    build(
      'revision_local_failure',
      '反例：修订后局部失效',
      '修订 lane_2 一条带的像素中心，使其局部依赖失效；只该带与受影响推断失效，其余结论保持。',
      straightSpines(),
      sampleBands(),
      [
        { code: 'local_invalidation', state: 'invalid', laneId: 'lane_2', message: '修订后该带旧工件局部失效，旧结论保留但标记 superseded', adopted: true },
        { code: 'scope_limited', message: '失效范围被限制在该带的依赖子图，ladder 与其他泳道版本不变', adopted: true }
      ]
    )
  )

  return { format: 'gel-casepack', generatedAt: 'CASEPACK', scenarios }
}
