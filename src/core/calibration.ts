import { contentId } from '../shared/identity'
import type { Diagnostic, Quantity } from '../shared/types'
import type {
  BandObservation,
  CalibrationArtifact,
  CalibrationPoint,
  CalibrationSegment,
  InputDigest,
  LadderNominal
} from './events'

export interface AlignedBand {
  observation: BandObservation
  slot: number
}

export interface AlignResult {
  aligned: AlignedBand[]
  unaligned: BandObservation[]
  diagnostics: Diagnostic[]
}

/** 解析 ladder 标称值原始文本（支持 "1500 bp"、"1.5kb"、"50 kDa"）。无法转换留在原位置并附诊断。 */
export function parseNominal(raw: string): { value: number | null; unit: 'bp' | 'kDa' | null; diagnostic?: Diagnostic } {
  const text = raw.trim()
  const m = text.match(/^([0-9]*\.?[0-9]+)\s*(kb|bp|kda)?$/i)
  if (!m) {
    return {
      value: null,
      unit: null,
      diagnostic: { code: 'nominal_unparseable', severity: 'error', message: `标称值无法转换，保留原值于原位置：${text}`, fragment: text, at: { field: 'nominal', x: 0, y: 0 } }
    }
  }
  let value = parseFloat(m[1])
  const unitRaw = (m[2] ?? '').toLowerCase()
  if (unitRaw === 'kb') {
    value *= 1000
    return { value, unit: 'bp' }
  }
  if (unitRaw === 'kda') return { value, unit: 'kDa' }
  if (unitRaw === 'bp' || unitRaw === '') return { value, unit: 'bp' }
  return { value: null, unit: null, diagnostic: { code: 'nominal_bad_unit', severity: 'error', message: `未知单位：${text}`, fragment: text } }
}

function monotonic(entries: LadderNominal[], tolLog: number): { ok: boolean; diag?: Diagnostic } {
  const values = entries.filter((e) => !e.declaredMissing).map((e) => e.nominal.value)
  for (let i = 1; i < values.length; i++) {
    if (Math.log10(values[i]) - Math.log10(values[i - 1]) > tolLog + 1e-9) {
      return {
        ok: false,
        diag: {
          code: 'nonmonotonic_ladder',
          severity: 'error',
          message: `ladder 标称值非单调：槽 ${i} 处 ${values[i - 1]} -> ${values[i]} 违背“迁移越大分子量越小”，标尺语义无解`,
          fragment: `${values[i - 1]} -> ${values[i]}`
        }
      }
    }
  }
  return { ok: true }
}

/**
 * 将 ladder 道观测带按弧长自上而下对齐到标称槽位。
 * 允许缺带（declaredMissing 或观测缺失），用动态规划求单调最优对齐。
 * s 越大迁移越远、分子量越小；标称按 slot 递增而分子量递减。
 */
export function alignLadderBands(
  entries: LadderNominal[],
  obs: BandObservation[],
  toleranceLog: number
): AlignResult {
  const diagnostics: Diagnostic[] = []
  const mono = monotonic(entries, toleranceLog)
  if (!mono.ok) {
    return { aligned: [], unaligned: obs, diagnostics: [mono.diag!] }
  }
  const expected = entries.filter((e) => !e.declaredMissing).sort((a, b) => a.slot - b.slot)
  const observed = [...obs].sort((a, b) => a.s - b.s)
  // 期望顺序：槽位小（上方）分子量更大，先出现。
  const n = expected.length
  const m = observed.length
  if (m === 0) {
    diagnostics.push({ code: 'no_ladder_bands', severity: 'error', message: 'ladder 道未观测到任何带，无法校准' })
    return { aligned: [], unaligned: [], diagnostics }
  }
  // DP：匹配 / 跳过期望带（缺带）/ 跳过杂散观测
  const NEG = -1e12
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG))
  const choice: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  dp[0][0] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue
      let best = NEG
      let take = -1
      if (i > 0 && j > 0) {
        // 匹配：奖励与等距间距一致性（用 log 标称的线性相关近似）
        const cand = dp[i - 1][j - 1] + 10
        if (cand > best) {
          best = cand
          take = 0
        }
      }
      if (i > 0) {
        const cand = dp[i - 1][j] - 2 // 缺带惩罚
        if (cand > best) {
          best = cand
          take = 1
        }
      }
      if (j > 0) {
        const cand = dp[i][j - 1] - 3 // 杂散带惩罚
        if (cand > best) {
          best = cand
          take = 2
        }
      }
      dp[i][j] = best
      choice[i][j] = take
    }
  }
  const aligned: AlignedBand[] = []
  const unalignedSet = new Set(observed.map((o) => o.bandId))
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const c = choice[i][j]
    if (c === 0) {
      aligned.push({ observation: observed[j - 1], slot: expected[i - 1].slot })
      unalignedSet.delete(observed[j - 1].bandId)
      i--
      j--
    } else if (c === 1) i--
    else j--
  }
  aligned.sort((a, b) => a.slot - b.slot)
  const unaligned = observed.filter((o) => unalignedSet.has(o.bandId))
  if (aligned.length < 2) {
    diagnostics.push({ code: 'ladder_insufficient', severity: 'error', message: `仅对齐 ${aligned.length} 个 ladder 点，少于 2 个，无法建立标尺` })
  }
  const missingSlots = expected.length - aligned.length
  if (missingSlots > 0) {
    diagnostics.push({ code: 'ladder_missing_bands', severity: 'warning', message: `ladder 有 ${missingSlots} 个标称带缺失，缺带两侧分段插值，缺带点不参与拟合`, at: { laneId: obs[0]?.laneId } })
  }
  if (unaligned.length > 0) {
    diagnostics.push({ code: 'ladder_spurious', severity: 'warning', message: `${unaligned.length} 条 ladder 道观测带无法对应标称槽位，已排除`, at: { laneId: obs[0]?.laneId } })
  }
  return { aligned, unaligned, diagnostics }
}

export interface CalibInput {
  ladderLaneId: string
  unit: 'bp' | 'kDa'
  entries: LadderNominal[]
  observations: BandObservation[]
  /** ladder 泳道总弧长；校准在归一化相对迁移 r∈[0,1] 上进行，以支持弯曲泳道。 */
  ladderLaneLength: number
  toleranceLog: number
  residualSigma: number
  basisS: string
  inputDigest: InputDigest
}

export function buildCalibration(input: CalibInput): CalibrationArtifact {
  const rOf = (s: number) => (input.ladderLaneLength > 0 ? s / input.ladderLaneLength : NaN)
  const normalized: BandObservation[] = input.observations.map((o) => ({ ...o, s: rOf(o.s) }))
  const { aligned, diagnostics } = alignLadderBands(input.entries, normalized, input.toleranceLog)
  const entryBySlot = new Map(input.entries.map((e) => [e.slot, e]))

  let points: CalibrationPoint[] = aligned.map((a) => ({
    ladderBandId: a.observation.bandId,
    slot: a.slot,
    s: a.observation.s,
    nominal: entryBySlot.get(a.slot)!.nominal,
    declaredMissing: false,
    used: true
  }))
  // 声明缺失的标称带也保留为点（不参与拟合），保证来源完整。
  for (const e of input.entries) {
    if (e.declaredMissing && !points.some((p) => p.slot === e.slot)) {
      points.push({
        ladderBandId: `missing_slot_${e.slot}`,
        slot: e.slot,
      s: NaN,
        nominal: e.nominal,
        declaredMissing: true,
        used: false,
        excludeReason: 'declared_missing'
      })
    }
  }
  points.sort((a, b) => a.slot - b.slot)

  let status: CalibrationArtifact['status'] = 'ok'
  const usedPoints = points.filter((p) => p.used).sort((a, b) => a.s - b.s)

  if (diagnostics.some((d) => d.code === 'nonmonotonic_ladder')) {
    return {
      artifactId: contentId('art_calib', { status: 'semantic_impasse', digest: input.inputDigest }),
      kind: 'calibration',
      inputDigest: input.inputDigest,
      ladderLaneId: input.ladderLaneId,
      points,
      segments: [],
      validS: [NaN, NaN],
      basisS: input.basisS,
      unit: input.unit,
      diagnostics,
      status: 'semantic_impasse'
    }
  }

  if (usedPoints.length >= 3) {
    // 全局线性拟合 log10(M) ~ s，求残差，离群 ladder 点（缺带误对齐）剔除
    const xs = usedPoints.map((p) => p.s)
    const ys = usedPoints.map((p) => Math.log10(p.nominal.value))
    const fit = linfit(xs, ys)
    const residuals = ys.map((y, k) => y - (fit.a * xs[k] + fit.b))
    const sd = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length) || 1e-9
    for (const p of points) {
      if (!p.used) continue
      const k = usedPoints.findIndex((u) => u.ladderBandId === p.ladderBandId)
      const res = residuals[k]
      p.residualLog = res
      if (Math.abs(res) > input.residualSigma * sd) {
        p.used = false
        p.excludeReason = `residual_outlier(${(Math.abs(res) / sd).toFixed(1)}sigma)`
        diagnostics.push({
          code: 'ladder_outlier',
          severity: 'warning',
          message: `槽 ${p.slot} 拟合残差 ${(Math.abs(res) / sd).toFixed(1)}σ 超限，疑似缺带误对齐，已从拟合剔除`,
          at: { laneId: input.ladderLaneId }
        })
      }
    }
  }

  const finalPoints = points.filter((p) => p.used).sort((a, b) => a.s - b.s)
  const segments: CalibrationSegment[] = []
  for (let k = 0; k + 1 < finalPoints.length; k++) {
    const p0 = finalPoints[k]
    const p1 = finalPoints[k + 1]
    const a = (Math.log10(p1.nominal.value) - Math.log10(p0.nominal.value)) / (p1.s - p0.s)
    const b = Math.log10(p0.nominal.value) - a * p0.s
    segments.push({
      index: k,
      s0: p0.s,
      s1: p1.s,
      a,
      b,
      pointIds: [p0.ladderBandId, p1.ladderBandId]
    })
  }

  if (finalPoints.length < 2) {
    status = 'semantic_impasse'
    diagnostics.push({ code: 'calib_impossible', severity: 'error', message: '有效 ladder 点不足 2 个，分段标尺无法建立' })
  } else if (diagnostics.some((d) => d.severity === 'warning')) status = 'degraded'

  const validS: [number, number] = finalPoints.length >= 2 ? [finalPoints[0].s, finalPoints[finalPoints.length - 1].s] : [NaN, NaN]
  const artifactId = contentId('art_calib', {
    ladder: input.ladderLaneId,
    points: finalPoints.map((p) => [p.ladderBandId, Math.round(p.s), p.nominal.value]),
    digest: input.inputDigest
  })
  return {
    artifactId,
    kind: 'calibration',
    inputDigest: input.inputDigest,
    ladderLaneId: input.ladderLaneId,
    points,
    segments,
    validS,
    basisS: input.basisS,
    unit: input.unit,
    diagnostics,
    status
  }
}

export function linfit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length
  const mx = xs.reduce((a, x) => a + x, 0) / n
  const my = ys.reduce((a, y) => a + y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  const a = den === 0 ? 0 : num / den
  return { a, b: my - a * mx }
}
