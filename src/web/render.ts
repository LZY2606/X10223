import type { Artifact, CalibrationArtifact, DetectionArtifact, MwArtifact, AnyEvent } from './model'

export interface ReviewData {
  projectId: string
  branch: string
  branches: { branchId: string; parentBranch: string | null; label: string; forkedFromEvent: string | null }[]
  events: AnyEvent[]
  replay: {
    diagnostics: { code: string; severity: string; message: string; at?: { x?: number; y?: number; laneId?: string } }[]
    invalidations: unknown[]
    paramsVersion: string
    ladderRevision: number
    lanesRevision: number
    bandsRevision: number
  }
  artifacts: (Artifact & { valid: boolean; supersededBy: string | null; producedByEvent: string; branchId?: string })[]
  imageIds: string[]
}

export function pickArtifacts(artifacts: ReviewData['artifacts']) {
  const detection = artifacts.find((a) => a.kind === 'detection') as DetectionArtifact | undefined
  const calibration = artifacts.find((a) => a.kind === 'calibration') as CalibrationArtifact | undefined
  const mw = artifacts.find((a) => a.kind === 'mw_inference') as MwArtifact | undefined
  return { detection, calibration, mw }
}

export interface DrawOptions {
  selectedBand?: string
  highlightSegment?: number
  showProfile: boolean
  showResiduals: boolean
  validOnly: boolean
}

export function drawGel(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  data: ReviewData,
  opts: DrawOptions
): void {
  const { detection, calibration, mw } = pickArtifacts(data.artifacts)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.drawImage(img, 0, 0)

  // lane 曲线
  if (detection) {
    for (const lane of detection.proposedLanes) {
      ctx.beginPath()
      lane.spine.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.strokeStyle = lane.isLadder ? '#d29922' : '#4aa8ff'
      ctx.lineWidth = 1.5
      ctx.setLineDash(lane.isLadder ? [] : [6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      // 泳道半宽边界
      ctx.beginPath()
      ctx.strokeStyle = lane.isLadder ? 'rgba(210,153,34,.25)' : 'rgba(74,168,255,.2)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = lane.isLadder ? '#d29922' : '#4aa8ff'
      ctx.font = '11px sans-serif'
      ctx.fillText(lane.label, lane.spine[0].x - 26, 14)
    }
  }

  // 条带中心 + 轮廓 + 状态色
  if (detection) {
    for (const obs of detection.observations) {
      const lane = detection.proposedLanes.find((l) => l.laneId === obs.laneId)
      const inference = mw?.inferences.find((i) => i.bandId === obs.bandId)
      const selected = opts.selectedBand === obs.bandId
      let color = '#3fb950'
      if (inference?.state === 'candidates') color = '#d29922'
      else if (inference?.state === 'interval') color = '#bc8cff'
      else if (inference?.state === 'invalid') color = '#f85149'
      if (obs.saturated || obs.smear) color = inference?.state === 'interval' ? '#bc8cff' : color

      if (opts.showProfile && lane) {
        ctx.beginPath()
        obs.profile.forEach((pp, i) => {
          // 轮廓横向画在泳道左侧
          const baseX = lane.spine[0].x - lane.halfWidth - 6
          const x = baseX - pp.v * 0.22
          if (i === 0) ctx.moveTo(x, pp.s / polylineLen(lane.spine) * lane.spine[lane.spine.length - 1].y + 0)
          const y = pp.s
          ctx.lineTo(x, y)
        })
        ctx.strokeStyle = 'rgba(63,185,80,.55)'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(obs.at.x, obs.at.y, selected ? 7 : 4, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth = selected ? 3 : 2
      ctx.stroke()
      if (selected) {
        ctx.beginPath()
        ctx.arc(obs.at.x, obs.at.y, 11, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(74,168,255,.5)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }

  // 有效区域（ladder 覆盖的 r 区间映射到像素）
  if (calibration && detection && opts.highlightSegment === undefined) {
    const ladderLane = detection.proposedLanes.find((l) => l.laneId === calibration.ladderLaneId)
    if (ladderLane && !Number.isNaN(calibration.validS[0])) {
      const [r0, r1] = calibration.validS
      const total = polylineLen(ladderLane.spine)
      const p0 = atS(ladderLane.spine, r0 * total)
      const p1 = atS(ladderLane.spine, r1 * total)
      ctx.fillStyle = 'rgba(210,153,34,.07)'
      ctx.fillRect(0, p0.y, ctx.canvas.width, p1.y - p0.y)
      ctx.strokeStyle = 'rgba(210,153,34,.5)'
      ctx.setLineDash([3, 5])
      ctx.beginPath()
      ctx.moveTo(0, p0.y)
      ctx.lineTo(ctx.canvas.width, p0.y)
      ctx.moveTo(0, p1.y)
      ctx.lineTo(ctx.canvas.width, p1.y)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // 高亮插值段（点击 MW 回到 ladder 点与段）
  if (calibration && detection && opts.highlightSegment !== undefined) {
    const seg = calibration.segments[opts.highlightSegment]
    const ladderLane = detection.proposedLanes.find((l) => l.laneId === calibration.ladderLaneId)
    if (seg && ladderLane) {
      const total = polylineLen(ladderLane.spine)
      const p0 = atS(ladderLane.spine, seg.s0 * total)
      const p1 = atS(ladderLane.spine, seg.s1 * total)
      ctx.strokeStyle = '#bc8cff'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.lineTo(p1.x, p1.y)
      ctx.stroke()
      for (const id of seg.pointIds) {
        const pt = calibration.points.find((p) => p.ladderBandId === id)
        const ob = detection.observations.find((o) => o.bandId === id)
        if (pt && ob) {
          ctx.beginPath()
          ctx.arc(ob.at.x, ob.at.y, 9, 0, Math.PI * 2)
          ctx.strokeStyle = '#bc8cff'
          ctx.lineWidth = 2.5
          ctx.stroke()
        }
      }
    }
  }

  // 拟合残差
  if (calibration && detection && opts.showResiduals) {
    const ladderLane = detection.proposedLanes.find((l) => l.laneId === calibration.ladderLaneId)
    if (ladderLane) {
      const total = polylineLen(ladderLane.spine)
      for (const p of calibration.points) {
        if (p.declaredMissing) continue
        const ob = detection.observations.find((o) => o.bandId === p.ladderBandId)
        if (!ob || p.residualLog === undefined) continue
        const px = ob.at.x + (p.used ? 18 : 18)
        ctx.strokeStyle = p.used ? '#f85149' : 'rgba(248,81,73,.4)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(ob.at.x + 6, ob.at.y)
        ctx.lineTo(px, ob.at.y)
        ctx.lineTo(px, ob.at.y + Math.max(-40, Math.min(40, p.residualLog * 300)))
        ctx.stroke()
      }
      void total
    }
  }
}

function polylineLen(pts: { x: number; y: number }[]): number {
  let t = 0
  for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return t
}
function atS(pts: { x: number; y: number }[], s: number): { x: number; y: number } {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    const len = Math.hypot(dx, dy)
    if (acc + len >= s) {
      const t = (s - acc) / len
      return { x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t }
    }
    acc += len
  }
  return pts[pts.length - 1]
}
