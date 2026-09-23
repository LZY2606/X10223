import { decodePng, type GrayImage } from './png'
import { applyOrientation, polylineLength, projectToLane, type OrientedImage } from './geometry'
import { runDetection, sampleProfile } from './detection'
import { buildCalibration, parseNominal } from './calibration'
import { inferMolecularWeights } from './inference'
import { PARAMS_VERSIONS, requireParams, type CalibParams } from './params'
import { contentId } from '../shared/identity'
import type { Diagnostic } from '../shared/types'
import type {
  AnyEvent,
  Artifact,
  BandCenter,
  BandCentersSetEvent,
  BandObservation,
  CalibrationArtifact,
  DetectionArtifact,
  LadderNominal,
  LaneBoundary,
  MwArtifact
} from './events'

export interface ReplayImage {
  imageId: string
  name: string
  raw: GrayImage
  sha256: string
}

export interface ReplayState {
  projectId: string
  branchId: string
  images: Map<string, ReplayImage>
  oriented: Map<string, OrientedImage>
  orientation: Map<string, { rotationDeg: number; basisId: string }>
  saturationGray: Map<string, number>
  ladderLaneId: string | null
  ladderUnit: 'bp' | 'kDa'
  ladderEntries: LadderNominal[]
  ladderRevision: number
  ladderRawText: string
  lanes: LaneBoundary[]
  lanesRevision: number
  manualBands: BandCenter[]
  bandsRevision: number
  paramsVersion: string
  params: CalibParams
  detection: DetectionArtifact | null
  calibration: CalibrationArtifact | null
  mw: MwArtifact | null
  diagnostics: Diagnostic[]
  /** 每个工件的失效说明（修订后局部失效）。 */
  invalidations: { artifactId: string; becauseOfEvent: string; reason: string; scope: string[] }[]
}

export const DEFAULT_BUDGET_PIXELS = 20_000_000

export function emptyState(projectId: string, branchId: string, paramsVersion = 'calib-v1'): ReplayState {
  return {
    projectId,
    branchId,
    images: new Map(),
    oriented: new Map(),
    orientation: new Map(),
    saturationGray: new Map(),
    ladderLaneId: null,
    ladderUnit: 'bp',
    ladderEntries: [],
    ladderRevision: 0,
    ladderRawText: '',
    lanes: [],
    lanesRevision: 0,
    manualBands: [],
    bandsRevision: 0,
    paramsVersion,
    params: PARAMS_VERSIONS[paramsVersion],
    detection: null,
    calibration: null,
    mw: null,
    diagnostics: [],
    invalidations: []
  }
}

function latestImageId(events: AnyEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'image_added') return (events[i] as { imageId: string }).imageId
  return null
}

function manualObservations(state: ReplayState, imageId: string): BandObservation[] {
  const out: BandObservation[] = []
  const laneById = new Map(state.lanes.map((l) => [l.laneId, l]))
  for (const b of state.manualBands) {
    const lane = laneById.get(b.laneId)
    if (!lane) {
      state.diagnostics.push({ code: 'band_without_lane', severity: 'error', message: `条带 ${b.bandId} 引用未知泳道 ${b.laneId}`, at: { ...b.at, laneId: b.laneId } })
      continue
    }
    const proj = projectToLane(b.at, lane.spine)
    if (Math.abs(proj.d) > lane.halfWidth) {
      state.diagnostics.push({
        code: 'band_outside_lane',
        severity: 'warning',
        message: `条带 ${b.bandId} 距泳道中心线 ${Math.round(Math.abs(proj.d))}px，超出半宽 ${lane.halfWidth}px`,
        at: { ...b.at, laneId: b.laneId }
      })
    }
    const ori = state.oriented.get(imageId)
    let peak = 0
    if (ori) {
      const xi = Math.max(0, Math.min(ori.image.width - 1, Math.round(b.at.x)))
      const yi = Math.max(0, Math.min(ori.image.height - 1, Math.round(b.at.y)))
      peak = ori.image.data[yi * ori.image.width + xi]
    }
    const profile = sampleProfile(ori!.image, lane.spine, state.params.profileStepPx, Math.round(lane.halfWidth * 0.6))
    out.push({
      bandId: b.bandId,
      laneId: b.laneId,
      at: b.at,
      s: proj.s,
      peak,
      saturated: false,
      saturatedFraction: 0,
      smear: !!b.smear,
      overlapWith: [],
      profile,
      source: 'manual',
      diagnostics: b.smear ? [{ code: 'smeared_band', severity: 'warning', message: '人工标注拖尾，中心不确定，只能给候选/区间', at: { ...b.at, laneId: b.laneId } }] : []
    })
  }
  return out
}

function recompute(state: ReplayState, imageId: string, budgetPixels: number): void {
  const ori = state.oriented.get(imageId)
  if (!ori) return

  // 饱和阈值必须由曝光事件显式声明；未声明则返回带位置诊断，不使用隐式默认。
  const satGray = state.saturationGray.get(imageId)
  if (satGray === undefined) {
    state.diagnostics.push({ code: 'missing_exposure', severity: 'error', message: '尚未声明曝光与饱和阈值，不能判定饱和', at: { field: 'exposure', x: 0, y: 0 } })
  }

  const params: CalibParams = satGray === undefined ? state.params : { ...state.params, saturationGray: satGray }

  const eventDeps = (state as unknown as { _eventShas?: { ref: string; sha: string }[] })._eventShas ?? []
  const baseDigest = { deps: eventDeps, paramsVersion: state.paramsVersion, params: params as unknown as Record<string, unknown> }

  const useManualLanes = state.lanes.length > 0
  const detection = runDetection({
    imageId,
    image: ori.image,
    paramsVersion: state.paramsVersion,
    params,
    deps: baseDigest.deps,
    budgetPixels,
    forcedLanes: useManualLanes ? state.lanes : undefined
  })

  // 用人工条带替换对应泳道的自动带（若存在人工修订）
  let observations = detection.observations
  if (state.manualBands.length > 0) {
    const manualLanes = new Set(state.manualBands.map((b) => b.laneId))
    const manual = manualObservations(state, imageId)
    observations = [...detection.observations.filter((o) => !manualLanes.has(o.laneId)), ...manual]
  }

  const merged: DetectionArtifact = { ...detection, observations }
  state.detection = merged

  // 校准
  const ladderLane = state.lanes.find((l) => l.isLadder) ?? merged.proposedLanes.find((_, i) => i === 0)
  if (!state.ladderEntries.length) {
    state.diagnostics.push({ code: 'missing_ladder', severity: 'error', message: '尚未提供 ladder 标称值，分子量无标尺', at: { field: 'ladder', x: 0, y: 0 } })
    return
  }
  if (!ladderLane) {
    state.diagnostics.push({ code: 'missing_ladder_lane', severity: 'error', message: '未定位 ladder 泳道', at: { field: 'lane', x: 0, y: 0 } })
    return
  }
  state.ladderLaneId = ladderLane.laneId
  const ladderObs = observations.filter((o) => o.laneId === ladderLane.laneId)
  const ladderLen = polylineLength(ladderLane.spine)
  const calib = buildCalibration({
    ladderLaneId: ladderLane.laneId,
    unit: state.ladderUnit,
    entries: state.ladderEntries,
    observations: ladderObs,
    ladderLaneLength: ladderLen,
    toleranceLog: params.monotonicToleranceLog,
    residualSigma: params.missingResidualSigma,
    basisS: `arclength:${ladderLane.laneId}`,
    inputDigest: { ...baseDigest, deps: [...baseDigest.deps, { ref: merged.artifactId, sha: merged.artifactId }] }
  })
  state.calibration = calib
  if (calib.diagnostics) state.diagnostics.push(...calib.diagnostics)

  const byLane = new Map<string, BandObservation[]>()
  const laneLen = new Map<string, number>()
  for (const lane of merged.proposedLanes) {
    byLane.set(lane.laneId, observations.filter((o) => o.laneId === lane.laneId))
    laneLen.set(lane.laneId, polylineLength(lane.spine))
  }
  state.mw = inferMolecularWeights({
    calibration: calib,
    observationsByLane: byLane,
    laneLength: laneLen,
    inputDigest: { ...baseDigest, deps: [...baseDigest.deps, { ref: merged.artifactId, sha: merged.artifactId }, { ref: calib.artifactId, sha: calib.artifactId }] }
  })
  state.diagnostics.push(...state.mw.diagnostics)
}

export interface ReplayResult {
  state: ReplayState
  artifacts: Artifact[]
}

/** 从分支事件流重放到指定事件（不含之后），用于回到任意旧事件恢复当时版本与结论。 */
export function replay(
  events: AnyEvent[],
  blobs: Map<string, Uint8Array>,
  opts: { untilEventId?: string; budgetPixels?: number } = {}
): ReplayResult {
  const projectId = events[0]?.projectId ?? 'proj_unknown'
  const branchId = events[0]?.branchId ?? 'main'
  const state = emptyState(projectId, branchId)
  const artifacts: Artifact[] = []
  let included: AnyEvent[] = []
  const budget = opts.budgetPixels ?? DEFAULT_BUDGET_PIXELS

  for (const e of events) {
    included.push(e)
    if (opts.untilEventId && e.eventId === opts.untilEventId) break
    ;(state as unknown as { _eventShas: { ref: string; sha: string }[] })._eventShas = events
      .slice(0, included.length)
      .map((x) => ({ ref: x.eventId, sha: x.eventId }))

    switch (e.type) {
      case 'image_added': {
        const bytes = blobs.get(e.imageId)
        if (!bytes) {
          state.diagnostics.push({ code: 'missing_blob', severity: 'error', message: `图像 ${e.imageId} 原始字节缺失`, fragment: e.sha256 })
          break
        }
        const img = decodePng(bytes)
        state.images.set(e.imageId, { imageId: e.imageId, name: e.name, raw: img, sha256: e.sha256 })
        break
      }
      case 'orientation_declared': {
        const ri = state.images.get(e.imageId)
        if (!ri) {
          state.diagnostics.push({ code: 'orientation_without_image', severity: 'error', message: '方向声明早于图像', at: { field: 'rotationDeg', x: 0, y: 0 } })
          break
        }
        const ori = applyOrientation(e.imageId, ri.raw, e.rotationDeg)
        state.oriented.set(e.imageId, ori)
        state.orientation.set(e.imageId, { rotationDeg: e.rotationDeg, basisId: ori.basis.basisId })
        break
      }
      case 'exposure_declared': {
        state.saturationGray.set(e.imageId, e.saturationGray)
        break
      }
      case 'ladder_nominal_set': {
        const entries: LadderNominal[] = []
        for (const entry of e.entries) {
          const parsed = parseNominal(entry.raw)
          if (parsed.diagnostic) state.diagnostics.push({ ...parsed.diagnostic, at: { field: 'ladder', x: entry.slot, y: 0 }, fragment: entry.raw })
          entries.push({
            slot: entry.slot,
            raw: entry.raw,
            declaredMissing: entry.declaredMissing,
            nominal: parsed.value === null || !parsed.unit ? entry.nominal : { value: parsed.value, unit: parsed.unit, raw: entry.raw }
          })
        }
        state.ladderEntries = entries
        state.ladderUnit = e.unit
        state.ladderRevision = e.revision
        state.ladderRawText = e.rawText
        state.ladderLaneId = e.ladderLaneId
        break
      }
      case 'lane_boundaries_set': {
        state.lanes = e.lanes
        state.lanesRevision = e.revision
        break
      }
      case 'band_centers_set': {
        state.manualBands = e.bands
        state.bandsRevision = e.revision
        break
      }
      case 'decision': {
        if (e.verb === 'tune_params' && e.paramsVersion && PARAMS_VERSIONS[e.paramsVersion]) {
          state.paramsVersion = e.paramsVersion
          state.params = requireParams(e.paramsVersion)
        }
        break
      }
      case 'detection_run':
      case 'project_created':
        break
    }
  }

  const lastImg = (() => {
    for (let i = included.length - 1; i >= 0; i--) if (included[i].type === 'image_added') return (included[i] as { imageId: string }).imageId
    return null
  })()
  if (lastImg && state.oriented.has(lastImg)) {
    recompute(state, lastImg, budget)
    if (state.detection) artifacts.push(state.detection)
    if (state.calibration) artifacts.push(state.calibration)
    if (state.mw) artifacts.push(state.mw)
  }

  return { state, artifacts }
}

export function bandCenterId(laneId: string, at: { x: number; y: number }): string {
  return contentId('band', { laneId, x: Math.round(at.x), y: Math.round(at.y) })
}

export type { BandCentersSetEvent }
