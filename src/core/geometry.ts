import type { GrayImage } from './png'
import { rotateQuarters } from './png'
import type { PointXY } from '../shared/types'
import type { Basis } from '../shared/types'
import { makeBasis } from '../shared/identity'

export function polylineLength(points: PointXY[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

interface Seg {
  ax: number
  ay: number
  ux: number
  uy: number
  len: number
  s0: number
}

function segments(points: PointXY[]): Seg[] {
  const segs: Seg[] = []
  let s0 = 0
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x
    const ay = points[i - 1].y
    const dx = points[i].x - ax
    const dy = points[i].y - ay
    const len = Math.hypot(dx, dy) || 1e-9
    segs.push({ ax, ay, ux: dx / len, uy: dy / len, len, s0 })
    s0 += len
  }
  return segs
}

/** 把任意像素点投影到泳道折线，返回沿弧长 s 与横向偏移 d（左负右正）。 */
export function projectToLane(p: PointXY, spine: PointXY[]): { s: number; d: number; foot: PointXY } {
  const segs = segments(spine)
  let best = { dist2: Infinity, s: 0, d: 0, fx: 0, fy: 0 }
  for (const seg of segs) {
    const rx = p.x - seg.ax
    const ry = p.y - seg.ay
    let t = rx * seg.ux + ry * seg.uy
    t = Math.max(0, Math.min(seg.len, t))
    const fx = seg.ax + seg.ux * t
    const fy = seg.ay + seg.uy * t
    const dx = p.x - fx
    const dy = p.y - fy
    const dist2 = dx * dx + dy * dy
    if (dist2 < best.dist2) {
      // 法向（左负右正）：切向顺时针 90 度为 (+uy,-ux)
      const d = dx * seg.uy - dy * seg.ux
      best = { dist2, s: seg.s0 + t, d, fx, fy }
    }
  }
  return { s: best.s, d: best.d, foot: { x: best.fx, y: best.fy } }
}

/** s -> 曲线上的点（用于把 ladder 弧长映射回像素，前端画插值段）。 */
export function pointAtS(spine: PointXY[], s: number): PointXY {
  const segs = segments(spine)
  const total = polylineLength(spine)
  const ss = Math.max(0, Math.min(total, s))
  for (const seg of segs) {
    if (ss <= seg.s0 + seg.len || seg === segs[segs.length - 1]) {
      const t = Math.max(0, Math.min(seg.len, ss - seg.s0))
      return { x: seg.ax + seg.ux * t, y: seg.ay + seg.uy * t }
    }
  }
  return spine[spine.length - 1]
}

export interface OrientedImage {
  imageId: string
  image: GrayImage
  rotationDeg: number
  basis: Basis
}

/**
 * 应用拍摄方向：在原图上旋转，使迁移方向严格向下。
 * 坐标基准随之切换为 oriented_image；旧像素坐标仍由 imageId 可回溯。
 */
export function applyOrientation(imageId: string, img: GrayImage, rotationDeg: number): OrientedImage {
  const quarters = ((Math.round(rotationDeg / 90) % 4) + 4) % 4
  const rotated = rotateQuarters(img, quarters)
  return {
    imageId,
    image: { width: rotated.width, height: rotated.height, data: rotated.data },
    rotationDeg: rotated.rotationDeg,
    basis: makeBasis(
      'oriented_image',
      'px',
      `oriented:${imageId}:rot${rotated.rotationDeg}`,
      `顺时针旋转 ${rotated.rotationDeg}° 后的像素坐标，原点左上、y 向下（迁移方向）`
    )
  }
}

/** 原图像素坐标 -> 旋转后坐标（像素级来源换算）。 */
export function transformPoint(p: PointXY, srcW: number, srcH: number, rotationDeg: number): PointXY {
  const r = (((Math.round(rotationDeg / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3
  if (r === 0) return { ...p }
  if (r === 1) return { x: srcH - 1 - p.y, y: p.x }
  if (r === 2) return { x: srcW - 1 - p.x, y: srcH - 1 - p.y }
  return { x: p.y, y: srcW - 1 - p.x }
}
