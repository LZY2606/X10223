import { contentId } from '../shared/identity'
import type { Quantity } from '../shared/types'
import type {
  BandObservation,
  CalibrationArtifact,
  InputDigest,
  MwArtifact,
  MwInference
} from './events'

export interface InferenceInput {
  calibration: CalibrationArtifact
  /** 每条泳道的观测带（含 ladder 道，ladder 不推断）。 */
  observationsByLane: Map<string, BandObservation[]>
  /** 每条泳道的总弧长（spine 长度），用于把绝对 s 归一化为相对迁移 r。 */
  laneLength: Map<string, number>
  inputDigest: InputDigest
}

function qty(value: number, unit: 'bp' | 'kDa'): Quantity {
  return { value: Math.round(value * 100) / 100, unit }
}

export function inferMolecularWeights(input: InferenceInput): MwArtifact {
  const calib = input.calibration
  const inferences: MwInference[] = []
  const unit = calib.unit

  const inferOne = (obs: BandObservation, r: number, s: number): MwInference => {
    const reasons: string[] = []
    const diagnostics: MwInference['diagnostics'] = []
    const outside = Number.isNaN(calib.validS[0]) || r < calib.validS[0] || r > calib.validS[1]

    let segIndex = -1
    for (const seg of calib.segments) {
      if (r >= seg.s0 - 1e-9 && r <= seg.s1 + 1e-9) {
        segIndex = seg.index
        break
      }
    }

    if (calib.status === 'semantic_impasse') {
      return {
        bandId: obs.bandId,
        laneId: obs.laneId,
        s,
        state: 'invalid',
        reasons: ['calibration_semantic_impasse'],
        diagnostics: [{ code: 'mw_no_ruler', severity: 'error', message: '标尺语义无解（如非单调 ladder），分子量不可推断', at: { ...obs.at, laneId: obs.laneId } }]
      }
    }

    if (outside || segIndex < 0) {
      return {
        bandId: obs.bandId,
        laneId: obs.laneId,
        s,
        state: 'invalid',
        reasons: ['outside_valid_region'],
        diagnostics: [
          {
            code: 'mw_outside_valid_region',
            severity: 'error',
            message: `相对迁移 r=${r.toFixed(3)} 落在标尺有效区域 [${calib.validS[0].toFixed(3)}, ${calib.validS[1].toFixed(3)}] 之外，禁止外推`,
            at: { ...obs.at, laneId: obs.laneId }
          }
        ]
      }
    }

    const seg = calib.segments[segIndex]
    const mCenter = Math.pow(10, seg.a * r + seg.b)
    // 相邻段端点值，构造局部区间
    const mAt = (rr: number) => {
      for (const sg of calib.segments) if (rr >= sg.s0 - 1e-9 && rr <= sg.s1 + 1e-9) return Math.pow(10, sg.a * rr + sg.b)
      return mCenter
    }

    const isUncertain = obs.saturated || obs.smear || obs.overlapWith.length > 0
    if (obs.saturated) reasons.push('saturated')
    if (obs.smear) reasons.push('smear_tail')
    if (obs.overlapWith.length > 0) reasons.push('overlap')

    if (obs.overlapWith.length > 0) {
      // 重叠：为每个重叠邻居在局部 r 偏移处保留合法候选（不唯一决定时保留全部）
      const candidates: Quantity[] = [qty(mCenter, unit)]
      const dr = 0.012
      candidates.push(qty(mAt(Math.min(calib.validS[1], r + dr)), unit))
      candidates.push(qty(mAt(Math.max(calib.validS[0], r - dr)), unit))
      const unique = [...new Map(candidates.map((c) => [c.value, c])).values()]
      reasons.push('multiple_legal_candidates_retained')
      return {
        bandId: obs.bandId,
        laneId: obs.laneId,
        s,
        state: 'candidates',
        candidates: unique,
        segmentIndex: segIndex,
        reasons,
        diagnostics: [{ code: 'mw_overlap_candidates', severity: 'warning', message: '重叠导致中心归属不唯一，保留全部合法候选，不做单点断言', at: { ...obs.at, laneId: obs.laneId } }]
      }
    }

    if (isUncertain) {
      const dr = obs.smear ? 0.02 : 0.012
      const hi = mAt(Math.max(calib.validS[0], r - dr))
      const lo = mAt(Math.min(calib.validS[1], r + dr))
      return {
        bandId: obs.bandId,
        laneId: obs.laneId,
        s,
        state: 'interval',
        interval: [qty(Math.min(lo, hi), unit), qty(Math.max(lo, hi), unit)],
        segmentIndex: segIndex,
        reasons,
        diagnostics: [
          {
            code: obs.saturated ? 'mw_saturated_interval' : 'mw_smear_interval',
            severity: 'warning',
            message: obs.saturated ? '饱和削平，峰值位置不可靠，仅给区间' : '拖尾使中心不可靠，仅给区间',
            at: { ...obs.at, laneId: obs.laneId }
          }
        ]
      }
    }

    return {
      bandId: obs.bandId,
      laneId: obs.laneId,
      s,
      state: 'unique',
      unique: qty(mCenter, unit),
      segmentIndex: segIndex,
      reasons: [],
      diagnostics: []
    }
  }

  for (const [laneId, observations] of input.observationsByLane) {
    if (laneId === calib.ladderLaneId) continue
    const len = input.laneLength.get(laneId)
    if (!len || !Number.isFinite(len) || len <= 0) {
      for (const obs of observations) {
        inferences.push({
          bandId: obs.bandId,
          laneId: obs.laneId,
          s: obs.s,
          state: 'invalid',
          reasons: ['missing_lane_geometry'],
          diagnostics: [{ code: 'mw_no_lane_geometry', severity: 'error', message: '缺少该泳道弧长基准，无法归一化相对迁移', at: { ...obs.at, laneId } }]
        })
      }
      continue
    }
    for (const obs of observations) {
      const r = obs.s / len
      inferences.push(inferOne(obs, r, obs.s))
    }
  }

  inferences.sort((a, b) => a.laneId.localeCompare(b.laneId) || a.s - b.s)
  const artifactId = contentId('art_mw', {
    calib: calib.artifactId,
    bands: inferences.map((i) => [i.bandId, i.state, i.segmentIndex]),
    digest: input.inputDigest
  })
  return {
    artifactId,
    kind: 'mw_inference',
    inputDigest: input.inputDigest,
    inferences,
    diagnostics: inferences.flatMap((i) => i.diagnostics)
  }
}
