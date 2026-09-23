import type { GrayImage } from './png'
import type { PointXY } from '../shared/types'
import { polylineLength } from './geometry'

export interface GelBandSpec {
  lane: number
  /** 归一化迁移位置 0=加样孔, 1=染料前沿；沿泳道曲线的弧长比例。 */
  r: number
  amp: number
  sigmaY?: number
  sigmaX?: number
  /** 拖尾：沿迁移方向的指数尾长度（像素）。 */
  smear?: number
}

export interface GelSpec {
  width?: number
  height?: number
  /** 每条泳道的真值折线（含加样孔端到染料前沿端）。 */
  spines: PointXY[][]
  bands: GelBandSpec[]
  background?: number
  noise?: number
  seed?: number
  /** 是否画加样孔/前沿的淡特征，供自动检测估计泳道范围。 */
  drawEnds?: boolean
}

export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 折线按弧长比例取点。 */
export function pointAtRatio(spine: PointXY[], r: number): { p: PointXY; s: number } {
  const total = polylineLength(spine)
  const target = Math.max(0, Math.min(total, r * total))
  let acc = 0
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i].x - spine[i - 1].x
    const dy = spine[i].y - spine[i - 1].y
    const len = Math.hypot(dx, dy)
    if (acc + len >= target || i === spine.length - 1) {
      const t = (target - acc) / (len || 1e-9)
      return { p: { x: spine[i - 1].x + dx * t, y: spine[i - 1].y + dy * t }, s: target }
    }
    acc += len
  }
  return { p: spine[spine.length - 1], s: total }
}

/** 直线泳道（含孔端 y0 与前沿 y1）。 */
export function straightSpine(x: number, y0: number, y1: number): PointXY[] {
  return [
    { x, y: y0 },
    { x, y: y1 }
  ]
}

/**
 * 微笑弯曲泳道：x 随归一化位置弯曲（弧长更长，条带像素高度与直道不同）。
 * bendAmp>0 时泳道呈 S 形弯曲；edgeBend 给整体“微笑”垂直位移。
 */
export function curvedSpine(x: number, y0: number, y1: number, bendAmp: number, smileOffset: number, steps = 40): PointXY[] {
  const pts: PointXY[] = []
  for (let i = 0; i <= steps; i++) {
    const r = i / steps
    const y = y0 + (y1 - y0) * r + smileOffset * Math.sin(Math.PI * r)
    const xx = x + bendAmp * Math.sin(Math.PI * r)
    pts.push({ x: Math.round(xx * 10) / 10, y: Math.round(y * 10) / 10 })
  }
  return pts
}

export interface RenderedBand extends GelBandSpec {
  x: number
  y: number
  s: number
}

export function renderGel(spec: GelSpec): GrayImage & { spines: PointXY[][]; rendered: RenderedBand[] } {
  const width = spec.width ?? 1000
  const height = spec.height ?? 800
  const bg = spec.background ?? 24
  const noise = spec.noise ?? 5
  const data = new Float32Array(width * height).fill(bg)
  const rendered: RenderedBand[] = []

  if (spec.drawEnds) {
    spec.spines.forEach((spine) => {
      for (const end of [spine[0], spine[spine.length - 1]]) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -26; dx <= 26; dx++) {
            const x = Math.round(end.x + dx)
            const y = Math.round(end.y + dy)
            if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] += 18
          }
        }
      }
    })
  }

  for (const b of spec.bands) {
    const spine = spec.spines[b.lane]
    const { p, s } = pointAtRatio(spine, b.r)
    const cx = p.x
    const cy = p.y
    const sx = b.sigmaX ?? 15
    const sy = b.sigmaY ?? 9
    const smear = b.smear ?? 0
    rendered.push({ ...b, x: cx, y: cy, s })
    const yLo = Math.max(0, Math.floor(cy - 4 * sy))
    const yHi = Math.min(height - 1, Math.ceil(cy + (smear ? 4 * smear : 4 * sy)))
    const xLo = Math.max(0, Math.floor(cx - 4 * sx))
    const xHi = Math.min(width - 1, Math.ceil(cx + 4 * sx))
    for (let y = yLo; y <= yHi; y++) {
      let profile = Math.exp(-(((y - cy) / sy) ** 2) / 2)
      if (smear > 0 && y > cy) profile += 0.6 * Math.exp(-(y - cy) / smear)
      if (profile < 0.004) continue
      for (let x = xLo; x <= xHi; x++) {
        const gx = Math.exp(-(((x - cx) / sx) ** 2) / 2)
        const idx = y * width + x
        data[idx] = Math.min(255, data[idx] + b.amp * profile * gx)
      }
    }
  }

  const rand = rng(spec.seed ?? 1234)
  const out = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) {
    const v = data[i] + (rand() - 0.5) * 2 * noise
    out[i] = Math.max(0, Math.min(255, Math.round(v)))
  }
  return { width, height, data: out, spines: spec.spines, rendered }
}
