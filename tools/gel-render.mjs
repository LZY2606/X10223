/**
 * 合成凝胶渲染器（离线案例包专用，无外部依赖）。
 * 同时输出“真值材料”（lane 曲线/band 中心/轮廓参数），供种子直接生成
 * origin=auto 的候选材料与人工修订版本，所有中心均为原始像素坐标。
 */
import { encodePng } from './png-encode.mjs';

export const LANE_LABELS = ['M', 'S1', 'S2', 'S3', 'S4'];

export function renderGel(spec) {
  const { width: W, height: H } = spec;
  const gray = Buffer.alloc(W * H, spec.background ?? 232);
  const noise = noiseGen(spec.seed ?? 1);
  for (let i = 0; i < gray.length; i++) {
    const n = (noise() - 0.5) * (spec.noise ?? 10);
    gray[i] = clamp(gray[i] + n);
  }

  const lanes = spec.lanes.map((ls, idx) => {
    const center = buildCenterline(ls, H, spec);
    const leftX = ls.x - (ls.width ?? 16) / 2;
    const rightX = ls.x + (ls.width ?? 16) / 2;
    // 泳道本身稍暗
    for (let y = spec.marginTop ?? 20; y < H - (spec.marginBottom ?? 20); y++) {
      const p = pointAtY(center, y);
      for (let x = Math.round(p.x - (ls.width ?? 16) / 2); x <= p.x + (ls.width ?? 16) / 2; x++) {
        if (x >= 0 && x < W) {
          const edge = Math.abs(x - p.x) / ((ls.width ?? 16) / 2);
          gray[y * W + x] = clamp(gray[y * W + x] - 10 * (1 - edge * 0.6));
        }
      }
      void leftX;
      void rightX;
    }
    return { spec: ls, index: idx, center, width: ls.width ?? 16 };
  });

  const bands = [];
  for (const lane of lanes) {
    for (const bandSpec of lane.spec.bands ?? []) {
      drawBand(gray, W, H, lane, bandSpec, bands, spec);
    }
  }
  return { gray, width: W, height: H, lanes, bands, png: encodePng(gray, W, H) };
}

function buildCenterline(ls, H, spec) {
  const top = spec.marginTop ?? 20;
  const bottom = H - (spec.marginBottom ?? 20);
  const pts = [];
  const samples = 40;
  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const y = top + f * (bottom - top);
    let x = ls.x;
    if (ls.bend) x += ls.bend * 4 * f * (1 - f);
    pts.push({ x, y });
  }
  return pts;
}

function pointAtY(points, y) {
  for (let i = 0; i < points.length - 1; i++) {
    if (y >= points[i].y && y <= points[i + 1].y) {
      const f = (y - points[i].y) / (points[i + 1].y - points[i].y || 1);
      return { x: points[i].x + f * (points[i + 1].x - points[i].x), y };
    }
  }
  return points[points.length - 1];
}

function drawBand(gray, W, H, lane, bs, bands, spec) {
  const centerPts = [];
  const cy = bs.y;
  const offsets = bs.overlapOffsets ?? [0];
  const amp = bs.amp ?? 120;
  const sigma = bs.sigma ?? 5;
  for (const off of offsets) {
    const p = pointAtY(lane.center, cy + off);
    centerPts.push({ x: p.x, y: cy + off });
    const halfW = lane.width / 2 - 1;
    const smear = bs.smear ?? 0;
    for (let dy = -sigma * 4 - smear; dy <= sigma * 4 + smear; dy++) {
      const yy = Math.round(cy + off + dy);
      if (yy < 0 || yy >= H) continue;
      const asym = smear > 0 && dy > 0 ? 1 + smear / sigma : 1;
      const gy = Math.exp(-(dy * dy) / (2 * sigma * sigma * asym));
      for (let dx = -halfW; dx <= halfW; dx++) {
        const xx = Math.round(p.x + dx);
        if (xx < 0 || xx >= W) continue;
        const gx = Math.exp(-(dx * dx) / (2 * halfW * halfW * 0.6));
        const target = clamp(gray[yy * W + xx] - amp * gy * gx);
        gray[yy * W + xx] = bs.saturated ? Math.min(target, spec.satGray ?? 18) : target;
      }
    }
  }
  for (const c of centerPts) {
    bands.push({
      laneIndex: lane.index,
      role: lane.spec.role,
      x: c.x,
      y: c.y,
      sigma,
      amp,
      saturated: Boolean(bs.saturated),
      smeared: (bs.smear ?? 0) > 0,
      fwhm: Math.round(2.355 * sigma * ((bs.smear ?? 0) > 0 ? 1.5 : 1)),
      overlap: offsets.length > 1,
      mass: bs.mass ?? null,
      nominalRow: bs.nominalRow ?? null
    });
  }
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function noiseGen(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
