// 确定性合成凝胶图像生成：读取案例包材料，渲染像素级凝胶图。
// 输出稳定（固定种子），保证原图 sha256 可复现。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { encodeGrayPng } from './png';

const here = dirname(fileURLToPath(import.meta.url));
const caseDir = join(here, '..', 'cases', 'gel-smile-01');
const materials = JSON.parse(readFileSync(join(caseDir, 'materials.json'), 'utf8'));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const image = materials.materials.find((m: any) => m.kind === 'image');
const W = image.widthPx;
const H = image.heightPx;
const px = new Float64Array(W * H);
const rand = mulberry32(20260919);
for (let i = 0; i < W * H; i++) px[i] = 14 + rand() * 6;

function laneXAt(centerline: { x: number; y: number }[], y: number): number {
  for (let i = 1; i < centerline.length; i++) {
    if (y <= centerline[i].y) {
      const a = centerline[i - 1];
      const b = centerline[i];
      const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
      return a.x + t * (b.x - a.x);
    }
  }
  return centerline[centerline.length - 1].x;
}

function blot(cx: number, cy: number, amp: number, sigmaX: number, sigmaY: number, tail: boolean) {
  const x0 = Math.max(0, Math.floor(cx - 4 * sigmaX));
  const x1 = Math.min(W - 1, Math.ceil(cx + 4 * sigmaX));
  const y0 = Math.max(0, Math.floor(cy - 4 * sigmaY));
  const y1 = Math.min(H - 1, Math.ceil(cy + (tail ? 26 : 4 * sigmaY)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / sigmaX;
      const dy = (y - cy) / sigmaY;
      let v = amp * Math.exp(-0.5 * (dx * dx + dy * dy));
      if (tail && y > cy) v += amp * 0.35 * Math.exp(-0.5 * dx * dx) * Math.exp(-(y - cy) / 9);
      const idx = y * W + x;
      px[idx] = Math.min(255, px[idx] + v);
    }
  }
}

const lanes = materials.materials.filter((m: any) => m.kind === 'lane');
const marks = materials.materials.filter((m: any) => m.kind === 'ladderMark');
const bands = materials.materials.filter((m: any) => m.kind === 'bandCenter');

for (const lane of lanes) {
  // 加样孔
  const well = lane.centerline[0];
  for (let y = Math.max(0, well.y - 6); y < well.y + 2; y++) {
    for (let x = Math.round(well.x - 14); x < Math.round(well.x + 14); x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = 40;
    }
  }
  const laneMarks = marks.filter((m: any) => m.laneId === lane.id);
  for (const m of laneMarks) {
    const cx = laneXAt(lane.centerline, m.position.y);
    blot(cx, m.position.y, 150, 8, 3.2, false);
  }
  const laneBands = bands.filter((b: any) => b.laneId === lane.id);
  for (const b of laneBands) {
    const cx = laneXAt(lane.centerline, b.position.y);
    const saturated = b.flags.includes('saturated') || b.intensity >= 0.98;
    const amp = saturated ? 320 : 60 + b.intensity * 180;
    blot(cx, b.position.y, amp, 7, Math.max(2.5, b.halfWidthPx * 0.8), b.flags.includes('tailing'));
  }
}

const out = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) out[i] = Math.max(0, Math.min(255, Math.round(px[i])));
const png = encodeGrayPng(W, H, out);
mkdirSync(join(caseDir, 'images'), { recursive: true });
const file = join(caseDir, 'images', 'gel-baseline.png');
writeFileSync(file, png);
const sha = createHash('sha256').update(png).digest('hex');
console.log(`written ${file}`);
console.log(`sha256 ${sha}`);
console.log(`bytes ${png.length}`);
