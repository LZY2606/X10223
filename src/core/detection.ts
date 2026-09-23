import type { GrayImage } from './png'
import type { Diagnostic, PointXY } from '../shared/types'
import { DomainFailure } from '../shared/types'
import { contentId } from '../shared/identity'
import { polylineLength, projectToLane } from './geometry'
import type {
  BandObservation,
  DetectionArtifact,
  InputDigest,
  LaneBoundary
} from './events'
import type { CalibParams } from './params'

interface DetectionInput {
  imageId: string
  image: GrayImage
  paramsVersion: string
  params: CalibParams
  deps: { ref: string; sha: string }[]
  /** 像素处理预算（像素数）；超过即 budget_exhausted，与格式损坏、语义无解严格区分。 */
  budgetPixels: number
  forcedLanes?: LaneBoundary[]
}

export function columnProjection(img: GrayImage, threshold: number): { xs: number[]; energy: Float64Array } {
  const energy = new Float64Array(img.width)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const v = img.data[y * img.width + x]
      if (v > threshold) energy[x] += v - threshold
    }
  }
  const xs: number[] = []
  const base = 40
  for (let x = 2; x < img.width - 2; x++) {
    if (energy[x] > base && energy[x] >= energy[x - 1] && energy[x] >= energy[x + 1]) xs.push(x)
  }
  // 合并过近峰
  const merged: number[] = []
  for (const x of xs) {
    if (merged.length === 0 || x - merged[merged.length - 1] > 60) merged.push(x)
    else if (energy[x] > energy[merged[merged.length - 1]]) merged[merged.length - 1] = x
  }
  return { xs: merged, energy }
}

/** 在给定 x 附近窗口内逐行求能量质心，追踪弯曲泳道中心线。 */
function traceSpine(img: GrayImage, xCenter: number, halfW: number): { spine: PointXY[]; profile: number[] } {
  const spine: PointXY[] = []
  const profile: number[] = []
  for (let y = 0; y < img.height; y += 10) {
    let sumW = 0
    let sumX = 0
    let maxV = 0
    const xLo = Math.max(0, xCenter - halfW)
    const xHi = Math.min(img.width - 1, xCenter + halfW)
    for (let x = xLo; x <= xHi; x++) {
      const v = img.data[y * img.width + x]
      const w = Math.max(0, v - 30)
      sumW += w
      sumX += w * x
      if (v > maxV) maxV = v
    }
    const cx = sumW > 1 ? sumX / sumW : xCenter
    spine.push({ x: Math.round(cx * 10) / 10, y })
    profile.push(maxV)
  }
  spine.push({ x: spine[spine.length - 1].x, y: img.height - 1 })
  return { spine, profile }
}

/** 沿泳道折线等弧长步长采样强度轮廓（在折线附近取横向窗口平均）。 */
export function sampleProfile(img: GrayImage, spine: PointXY[], stepPx: number, halfW: number): { s: number; v: number }[] {
  const total = polylineLength(spine)
  const out: { s: number; v: number }[] = []
  for (let s = 0; s <= total; s += stepPx) {
    // 在 s 处找折线段并取法向窗口均值
    let acc = 0
    let px = spine[0].x
    let py = spine[0].y
    let nx = 0
    let ny = -1
    for (let i = 1; i < spine.length; i++) {
      const dx = spine[i].x - spine[i - 1].x
      const dy = spine[i].y - spine[i - 1].y
      const len = Math.hypot(dx, dy)
      if (acc + len >= s) {
        const t = (s - acc) / len
        px = spine[i - 1].x + dx * t
        py = spine[i - 1].y + dy * t
        nx = dy / len
        ny = -dx / len
        break
      }
      acc += len
    }
    let sum = 0
    let cnt = 0
    for (let d = -halfW; d <= halfW; d += 2) {
      const x = Math.round(px + nx * d)
      const y = Math.round(py + ny * d)
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        sum += img.data[y * img.width + x]
        cnt++
      }
    }
    out.push({ s, v: cnt ? sum / cnt : 0 })
  }
  return out
}

interface Peak {
  index: number
  s: number
  v: number
  leftBase: number
  rightBase: number
}

function findPeaks(profile: { s: number; v: number }[], noiseFloor: number): Peak[] {
  const peaks: Peak[] = []
  for (let i = 2; i < profile.length - 2; i++) {
    if (profile[i].v > noiseFloor && profile[i].v >= profile[i - 1].v && profile[i].v >= profile[i + 1].v) {
      let l = i
      let r = i
      while (l > 0 && profile[l - 1].v > noiseFloor && profile[l - 1].v <= profile[l].v + 1e-9) l--
      while (r < profile.length - 1 && profile[r + 1].v > noiseFloor && profile[r + 1].v <= profile[r].v + 1e-9) r++
      peaks.push({ index: i, s: profile[i].s, v: profile[i].v, leftBase: l, rightBase: r })
    }
  }
  // 合并弧长上极近峰（重叠带仍各自保留为候选，不做删并）
  return peaks
}

/** 用法向窗口统计带内饱和像素比例与局部最大。 */
function bandStats(img: GrayImage, spine: PointXY[], s: number, halfW: number, satGray: number) {
  let acc = 0
  let px = spine[0].x
  let py = spine[0].y
  let nx = 0
  let ny = -1
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i].x - spine[i - 1].x
    const dy = spine[i].y - spine[i - 1].y
    const len = Math.hypot(dx, dy)
    if (acc + len >= s) {
      const t = (s - acc) / len
      px = spine[i - 1].x + dx * t
      py = spine[i - 1].y + dy * t
      nx = dy / len
      ny = -dx / len
      break
    }
    acc += len
  }
  let total = 0
  let sat = 0
  let peak = 0
  for (let dd = -halfW; dd <= halfW; dd += 2) {
    for (let ds = -8; ds <= 8; ds += 2) {
      const x = Math.round(px + nx * dd)
      const y = Math.round(py + ny * dd + ds)
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        const v = img.data[y * img.width + x]
        total++
        if (v >= satGray) sat++
        if (v > peak) peak = v
      }
    }
  }
  return { saturatedFraction: total ? sat / total : 0, peak }
}

export function runDetection(input: DetectionInput): DetectionArtifact {
  const { image, params } = input
  const pixelsTouched = image.width * image.height
  if (pixelsTouched > input.budgetPixels) {
    throw new DomainFailure(
      'budget_exhausted',
      `资源预算耗尽：图像 ${pixelsTouched} 像素 > 预算 ${input.budgetPixels}`,
      [
        {
          code: 'budget_exhausted',
          severity: 'error',
          message: `需要处理 ${pixelsTouched} 像素，预算 ${input.budgetPixels}，拒绝继续`,
          fragment: `${image.width}x${image.height}`
        }
      ]
    )
  }

  const diagnostics: Diagnostic[] = []
  let lanes: LaneBoundary[]
  if (input.forcedLanes && input.forcedLanes.length > 0) {
    lanes = input.forcedLanes
  } else {
    const { xs } = columnProjection(image, 34)
    if (xs.length < 2) {
      throw new DomainFailure('semantic_impasse', '无法识别至少两条泳道', [
        { code: 'no_lanes', severity: 'error', message: `列投影仅得到 ${xs.length} 条候选泳道`, fragment: xs.join(',') }
      ])
    }
    lanes = xs.map((x, i) => {
      const { spine } = traceSpine(image, x, params.laneSearchHalfWidth)
      return { laneId: `lane_auto_${i + 1}`, label: `L${i + 1}`, spine, halfWidth: params.laneSearchHalfWidth }
    })
  }

  const observations: BandObservation[] = []
  for (const lane of lanes) {
    const profile = sampleProfile(image, lane.spine, params.profileStepPx, Math.round(lane.halfWidth * 0.6))
    const peaks = findPeaks(profile, 40)
    for (const pk of peaks) {
      const { saturatedFraction, peak } = bandStats(image, lane.spine, pk.s, Math.round(lane.halfWidth * 0.6), params.saturationGray)
      // 局部前后强度比判定拖尾
      const i0 = pk.index
      const before = profile.slice(Math.max(0, i0 - 6), i0).reduce((a, b) => a + b.v, 0)
      const after = profile.slice(i0 + 1, Math.min(profile.length, i0 + 7)).reduce((a, b) => a + b.v, 0)
      const smear = after > before * params.smearTailRatio
      const bandId = contentId('band', { laneId: lane.laneId, s: Math.round(pk.s) })
      const foot = projectToLane(pointOnSpine(lane.spine, pk.s), lane.spine)
      void foot
      const obs: BandObservation = {
        bandId,
        laneId: lane.laneId,
        at: pointOnSpine(lane.spine, pk.s),
        s: pk.s,
        peak,
        saturated: saturatedFraction > params.saturatedFractionLimit,
        saturatedFraction,
        smear,
        overlapWith: [],
        profile,
        source: 'auto',
        diagnostics: []
      }
      if (obs.saturated) {
        obs.diagnostics.push({
          code: 'saturated_band',
          severity: 'warning',
          message: `饱和像素比例 ${(saturatedFraction * 100).toFixed(1)}% 超限，峰值被削平，只能给候选/区间`,
          at: { ...obs.at, laneId: lane.laneId }
        })
      }
      if (smear) {
        obs.diagnostics.push({
          code: 'smeared_band',
          severity: 'warning',
          message: '迁移方向拖尾，中心不确定，只能给候选/区间',
          at: { ...obs.at, laneId: lane.laneId }
        })
      }
      observations.push(obs)
    }
  }

  // 同泳道重叠判定（两带基区重叠比例）
  for (const lane of lanes) {
    const mine = observations.filter((o) => o.laneId === lane.laneId).sort((a, b) => a.s - b.s)
    for (let i = 0; i + 1 < mine.length; i++) {
      const a = mine[i]
      const b = mine[i + 1]
      const sigma = params.profileStepPx * 2.2
      const dist = b.s - a.s
      const fraction = Math.max(0, Math.min(1, 1 - dist / (2 * sigma)))
      if (fraction > params.overlapFractionLimit) {
        a.overlapWith.push({ bandId: b.bandId, fraction })
        b.overlapWith.push({ bandId: a.bandId, fraction })
        const msg = `与相邻带重叠 ${(fraction * 100).toFixed(0)}%，保留全部合法候选`
        a.diagnostics.push({ code: 'overlap', severity: 'warning', message: msg, at: { ...a.at, laneId: lane.laneId } })
        b.diagnostics.push({ code: 'overlap', severity: 'warning', message: msg, at: { ...b.at, laneId: lane.laneId } })
      }
    }
  }

  const inputDigest: InputDigest = {
    deps: input.deps,
    paramsVersion: input.paramsVersion,
    params: input.params as unknown as Record<string, unknown>
  }
  const artifactId = contentId('art_detection', {
    imageId: input.imageId,
    lanes: lanes.map((l) => l.laneId + ':' + l.spine.length),
    bands: observations.map((o) => o.bandId),
    digest: inputDigest
  })

  if (lanes.some((l) => l.spine.length > 2)) {
    diagnostics.push({ code: 'curved_lanes', severity: 'info', message: '检测到多段折线泳道，弧长投影校正弯曲；同一像素高度不等于同一分子量' })
  }

  return {
    artifactId,
    kind: 'detection',
    inputDigest,
    imageId: input.imageId,
    proposedLanes: lanes,
    observations,
    diagnostics,
    budget: { pixels: pixelsTouched, budgetPixels: input.budgetPixels, exhausted: false }
  }
}

export function pointOnSpine(spine: PointXY[], s: number): PointXY {
  let acc = 0
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i].x - spine[i - 1].x
    const dy = spine[i].y - spine[i - 1].y
    const len = Math.hypot(dx, dy)
    if (acc + len >= s) {
      const t = (s - acc) / len
      return { x: spine[i - 1].x + dx * t, y: spine[i - 1].y + dy * t }
    }
    acc += len
  }
  return spine[spine.length - 1]
}
