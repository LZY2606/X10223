// 拍摄方向：旋转/镜像只改变解释帧，原始像素坐标始终保留。
import type { CoordinateFrame, Vec2 } from "./types";
import { pixelUnit } from "./units";

export function originalFrame(width: number, height: number): CoordinateFrame {
  return {
    frameId: "original",
    origin: "top-left",
    rotationQuarterTurns: 0,
    mirrored: false,
    width,
    height,
    unit: pixelUnit()
  };
}

export function interpretedFrame(
  base: CoordinateFrame,
  rotationQuarterTurns: 0 | 1 | 2 | 3,
  mirrored: boolean
): CoordinateFrame {
  const swap = rotationQuarterTurns % 2 === 1;
  return {
    frameId: `interpreted:r${rotationQuarterTurns}${mirrored ? "m" : ""}`,
    origin: "top-left",
    rotationQuarterTurns,
    mirrored,
    width: swap ? base.height : base.width,
    height: swap ? base.width : base.height,
    unit: pixelUnit()
  };
}

/** 原始像素 -> 解释帧像素 */
export function toInterpreted(
  p: Vec2,
  base: CoordinateFrame,
  rotation: 0 | 1 | 2 | 3,
  mirrored: boolean
): Vec2 {
  let { x, y } = p;
  const w = base.width;
  const h = base.height;
  if (mirrored) x = w - 1 - x;
  switch (rotation) {
    case 0:
      return { x, y };
    case 1:
      return { x: h - 1 - y, y: x };
    case 2:
      return { x: w - 1 - x, y: h - 1 - y };
    case 3:
      return { x: y, y: w - 1 - x };
  }
}

/** 解释帧像素 -> 原始像素（复核时点击回溯） */
export function toOriginal(
  p: Vec2,
  base: CoordinateFrame,
  rotation: 0 | 1 | 2 | 3,
  mirrored: boolean
): Vec2 {
  const w = base.width;
  const h = base.height;
  let out: Vec2;
  switch (rotation) {
    case 0:
      out = { x: p.x, y: p.y };
      break;
    case 1:
      out = { x: p.y, y: h - 1 - p.x };
      break;
    case 2:
      out = { x: w - 1 - p.x, y: h - 1 - p.y };
      break;
    case 3:
      out = { x: w - 1 - p.y, y: p.x };
      break;
  }
  if (mirrored) out = { x: w - 1 - out.x, y: out.y };
  return out;
}
