/**
 * 离线案例包生成器：胶道标尺 —— 电泳条带、泳道弯曲与分子量校准工作台。
 * 全部输出确定性（固定种子），重复生成字节一致。
 * 运行：npm run gen:casepack
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthGelPng, laneCurveX, type SynthLane } from '../src/core/synth';
import { rotateRaster, decodePng, encodePng } from '../src/core/png';
import { sha256Hex } from '../src/shared/ids';

const ROOT = join(import.meta.dirname);
const IMG = join(ROOT, 'images');
mkdirSync(IMG, { recursive: true });

const WIDTH = 480, HEIGHT = 640, Y_TOP = 60, Y_BOTTOM = 600;
const LADDER_SIZES = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500];
const LOG_MAX = Math.log10(LADDER_SIZES[0]);
const LOG_MIN = Math.log10(LADDER_SIZES[LADDER_SIZES.length - 1]);
const rfOf = (bp: number) => 0.05 + 0.9 * (LOG_MAX - Math.log10(bp)) / (LOG_MAX - LOG_MIN);

// 5 条泳道：0=ladder，1..4=样品；微笑弯曲：中间泳道弧度最大
const laneX0 = [60, 140, 220, 300, 380];
const laneCurv = [6, 18, 30, 18, 6];

interface BandSpec { rf: number; intensity: number; heightPx: number; trailing?: boolean; saturated?: boolean; overlapping?: boolean }

const laneBands: BandSpec[][] = [
  LADDER_SIZES.map((bp) => ({ rf: rfOf(bp), intensity: 0.8, heightPx: 4 })),
  [ // lane 1：常规条带
    { rf: 0.18, intensity: 0.75, heightPx: 4 },
    { rf: 0.42, intensity: 0.7, heightPx: 4 },
    { rf: 0.66, intensity: 0.72, heightPx: 4 },
    { rf: 0.85, intensity: 0.68, heightPx: 4 },
  ],
  [ // lane 2：一条饱和带 + 常规带
    { rf: 0.30, intensity: 1.0, heightPx: 5, saturated: true },
    { rf: 0.58, intensity: 0.7, heightPx: 4 },
    { rf: 0.78, intensity: 0.65, heightPx: 4 },
  ],
  [ // lane 3：两条重叠带 + 常规带
    { rf: 0.470, intensity: 0.7, heightPx: 5, overlapping: true },
    { rf: 0.492, intensity: 0.7, heightPx: 5, overlapping: true },
    { rf: 0.72, intensity: 0.7, heightPx: 4 },
  ],
  [ // lane 4：拖尾带 + 常规带
    { rf: 0.35, intensity: 0.75, heightPx: 4, trailing: true },
    { rf: 0.62, intensity: 0.7, heightPx: 4 },
  ],
];

const lanes: SynthLane[] = laneX0.map((x0, i) => ({
  x0, curvature: laneCurv[i],
  bands: laneBands[i].map((b) => ({
    rf: b.rf, intensity: b.intensity, widthPx: 9, heightPx: b.heightPx, trailing: b.trailing,
  })),
}));

const png = synthGelPng({ width: WIDTH, height: HEIGHT, yTop: Y_TOP, yBottom: Y_BOTTOM, lanes, backgroundNoise: 6, seed: 20260919 });
writeFileSync(join(IMG, 'gel-baseline.png'), png);

// 旋转 90° 版本也作为独立图像材料入包（旋转图像情形）
const rotated = encodePng(rotateRaster(decodePng(png), 90));
writeFileSync(join(IMG, 'gel-rotated-90.png'), rotated);

/* ---------- 真值观测（全部带像素级来源） ---------- */

const centerlineOf = (laneIdx: number) => {
  const pts = [];
  for (let k = 0; k <= 20; k++) {
    const t = k / 20;
    pts.push({
      x: Math.round(laneCurveX({ x0: laneX0[laneIdx], curvature: laneCurv[laneIdx] }, t) * 1000) / 1000,
      y: Math.round((Y_TOP + t * (Y_BOTTOM - Y_TOP)) * 1000) / 1000,
      unit: 'px', frame: 'image',
    });
  }
  return pts;
};

const groundTruth = {
  coordinateBasis: { frame: 'image', origin: 'top-left', xAxis: 'right', yAxis: 'down', unit: 'px' },
  timeBasis: 'ISO-8601/UTC',
  capture: {
    imageId: 'img:baseline',
    file: 'images/gel-baseline.png',
    orientation: { rotationDeg: 0, mirrored: false },
    exposure: { timeMs: { value: 120, unit: 'ms' }, gain: 2.0, saturatedPixels: { value: 173, unit: 'count' }, saturating: true },
    capturedAt: '2026-09-19T00:33:12Z',
  },
  ladderNominal: {
    laneIndex: 0,
    name: '1kb DNA Ladder（标称）',
    fragments: LADDER_SIZES.map((bp, i) => ({ size: { value: bp, unit: 'bp' }, ordinal: i })),
  },
  lanes: laneX0.map((x0, i) => ({
    laneIndex: i,
    role: i === 0 ? 'ladder' : 'sample',
    centerline: centerlineOf(i),
    boundary: {
      left: centerlineOf(i).map((p) => ({ ...p, x: p.x - 16 })),
      right: centerlineOf(i).map((p) => ({ ...p, x: p.x + 16 })),
    },
  })),
  bands: laneBands.flatMap((bs, laneIdx) =>
    bs.map((b, k) => {
      const t = b.rf;
      const y = Y_TOP + t * (Y_BOTTOM - Y_TOP);
      const x = laneCurveX({ x0: laneX0[laneIdx], curvature: laneCurv[laneIdx] }, t);
      return {
        laneIndex: laneIdx,
        bandKey: `L${laneIdx}B${k}`,
        center: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, unit: 'px', frame: 'image' },
        halfWidthPx: { value: 9, unit: 'px' },
        halfHeightPx: { value: b.heightPx, unit: 'px' },
        peakIntensity: Math.min(1, b.intensity),
        saturated: !!b.saturated,
        overlapping: !!b.overlapping,
        trailing: !!b.trailing,
      };
    }),
  ),
};
writeFileSync(join(ROOT, 'ground-truth.json'), JSON.stringify(groundTruth, null, 2));

/* ---------- 边界情形脚本（七类） ---------- */
const scenarios = [
  { id: 'rotate-image', title: '旋转图像', kind: 'scenario',
    payload: { op: 'rotate', angleDeg: 90, imageId: 'img:baseline', derivedImageId: 'img:rotated-90', file: 'images/gel-rotated-90.png' },
    expect: '拍摄方向仅作为观察属性；派生分子量不变，像素来源经显示变换映射' },
  { id: 'bend-lanes', title: '弯曲泳道（微笑加剧）', kind: 'scenario',
    payload: { op: 'bend-lanes', curvatureDelta: 25 },
    expect: '同一图像高度不再等于同一分子量；rf 沿各泳道弧长重算' },
  { id: 'ladder-missing-band', title: 'ladder 缺带', kind: 'scenario',
    payload: { op: 'exclude-band', laneIndex: 0, bandKey: 'L0B4', nominalOrdinal: 4 },
    expect: '缺带必须显式声明；跨越缺口的插值段变宽并告警' },
  { id: 'saturation', title: '饱和区', kind: 'scenario',
    payload: { op: 'mark-saturated', laneIndex: 2, bandKey: 'L2B0' },
    expect: '饱和条带只能给出区间估计，不给唯一点值' },
  { id: 'overlap-pair', title: '两条带重叠', kind: 'scenario',
    payload: { op: 'mark-overlap', laneIndex: 3, bandKeys: ['L3B0', 'L3B1'] },
    expect: '重叠条带只能作为候选，保留全部合法候选' },
  { id: 'nonmonotonic-scale', title: '非单调标尺', kind: 'scenario',
    payload: { op: 'swap-nominal', ordinals: [4, 5] },
    expect: '迁移顺序与标称尺寸矛盾的插值段判为失效，带像素位置诊断' },
  { id: 'local-invalidation', title: '修订后局部失效', kind: 'scenario',
    payload: { op: 'revise-band-center', laneIndex: 2, bandKey: 'L2B1', dyPx: 12 },
    expect: '只有依赖该条带的分子量估计改变身份，其余派生结果 id 不变' },
];
writeFileSync(join(ROOT, 'scenarios.json'), JSON.stringify(scenarios, null, 2));

/* ---------- 初始重放脚本：参数修订 + 局部源改动 + 冲突决定 ---------- */
const replay = [
  { kind: 'param-change', actor: 'reviewer.lin',
    payload: { from: 'params/v1', to: 'params/v2', change: { saturationThreshold: [0.98, 0.95] } },
    note: '参数修订：饱和阈值收紧' },
  { kind: 'source-revision', actor: 'reviewer.lin',
    payload: { op: 'revise-band-center', laneIndex: 4, bandKey: 'L4B1', dyPx: 6 },
    note: '局部源数据改动：仅影响 lane 4 的 L4B1 估计' },
  { kind: 'decision', actor: 'reviewer.lin', branch: 'main',
    payload: { action: 'accept', subjectKey: 'L3B0', rationale: '重叠对中靠上条带与预期 4200bp 一致，接受为候选' },
    note: '人工决定 A：接受重叠候选' },
  { kind: 'decision', actor: 'reviewer.qa', branch: 'review-qa',
    payload: { action: 'reject', subjectKey: 'L3B0', rationale: '重叠未解卷积，不应接受任何单值', rationaleCode: 'conflict' },
    note: '人工决定 B（冲突）：否定同一候选，两条决定都保留' },
];
writeFileSync(join(ROOT, 'replay.json'), JSON.stringify(replay, null, 2));

/* ---------- 清单 ---------- */
const files = ['images/gel-baseline.png', 'images/gel-rotated-90.png', 'ground-truth.json', 'scenarios.json', 'replay.json'];
const { readFileSync } = await import('node:fs');
const manifest = {
  packId: 'gel-scale-bench',
  version: 1,
  generatedAt: '2026-09-19T00:33:12Z',
  files: Object.fromEntries(files.map((f) => [f, { sha256: sha256Hex(readFileSync(join(ROOT, f))) }])),
};
writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('casepack generated:', files.join(', '));
