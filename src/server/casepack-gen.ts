import { PNG } from "pngjs";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { contentId, sha256Hex } from "../shared/ids.js";
import { EVIDENCE_CODES } from "../shared/evidence.js";

export const CASE_PACK_FORMAT = "gel-ruler-casepack/1";

export interface GroundTruthBand {
  laneOrdinal: number;
  nominal: string | null;
  center: { x: number; y: number };
  kind: "normal" | "saturated" | "tailing" | "overlap-a" | "overlap-b" | "faint";
}

export interface ManualRevisionSpec {
  type: "revise-center" | "add-band";
  laneOrdinal: number;
  at: { x: number; y: number };
  center: { x: number; y: number };
  widthPx: number;
  heightPx: number;
  reason: string;
}

export interface CasePackScenarioSpec {
  id: string;
  title: string;
  description: string;
  kind: "assert" | "mutate";
  mutate:
    | { type: "param-revision"; patch: Record<string, unknown> }
    | { type: "rotate"; clockwiseDegrees: number }
    | { type: "missing-band"; ladderLaneOrdinal: number; nominal: string }
    | { type: "nonmonotonic-spec"; badOrdinal: number; badNominal: string }
    | { type: "local-revision"; ladderLaneOrdinal: number; nominal: string; shiftArcPx: number }
    | { type: "conflict"; inferenceKey: string; branch: string }
    | null;
  expect: {
    evidenceCodes?: string[];
    changedFitLaneOrdinals?: number[];
    unchangedFitLaneOrdinals?: number[];
  };
}

export interface CasePackManifest {
  format: typeof CASE_PACK_FORMAT;
  id: string;
  title: string;
  domain: "gel-electrophoresis";
  narrative: string;
  image: { file: string; sha256: string; width: number; height: number; capturedAt: string };
  orientation: { clockwiseDegrees: string; timeBase: string };
  exposure: {
    exposureDuration: string;
    gainRaw: string;
    saturationLevelRaw: string;
    pixelValueRange: [number, number];
    coordinateBasis: string;
  };
  ladderSpec: {
    name: string;
    dimension: "mass-fragment";
    bands: { ordinal: number; present: boolean; nominal: string }[];
  };
  groundTruth: {
    lanes: { ordinal: number; role: "ladder" | "sample"; seedX: number; halfWidth: number; polyline: { x: number; y: number }[] }[];
    bands: GroundTruthBand[];
  };
  manualRevisions: ManualRevisionSpec[];
  scenarios: CasePackScenarioSpec[];
}

const W = 640;
const H = 480;
const SEED_XS = [70, 160, 250, 340, 430, 520];
const ROLES: ("ladder" | "sample")[] = ["ladder", "sample", "sample", "ladder", "sample", "sample"];
const SMILE_AMP = 26;
const LATERAL_BOW = 3;
const CAPTURED_AT = "2026-09-19T09:30:00+09:00";

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

function centerXAtY(seedX: number, y: number): number {
  return seedX + LATERAL_BOW * Math.sin((2 * Math.PI * y) / H);
}

function smileOffset(seedX: number): number {
  const r = (seedX - W / 2) / (W / 2);
  return -SMILE_AMP * r * r;
}

function yForBp(bp: number): number {
  return 40 + (4 - Math.log10(bp)) * 150;
}

interface DrawnBand {
  laneOrdinal: number;
  nominal: string | null;
  bp: number | null;
  cx: number;
  cy: number;
  amp: number;
  kind: GroundTruthBand["kind"];
  sigmaYUp: number;
  sigmaYDown: number;
}

function buildBands(): DrawnBand[] {
  const out: DrawnBand[] = [];
  const add = (laneOrdinal: number, bp: number | null, amp: number, kind: DrawnBand["kind"], sigmaYUp = 2.2, sigmaYDown = 2.6) => {
    const seedX = SEED_XS[laneOrdinal] as number;
    const cy = (bp === null ? 0 : yForBp(bp)) + smileOffset(seedX);
    const cx = centerXAtY(seedX, cy);
    out.push({ laneOrdinal, nominal: bp === null ? null : `${bp} bp`, bp, cx, cy, amp, kind, sigmaYUp, sigmaYDown });
  };
  for (const bp of [10000, 7000, 5000, 3500, 2500, 1800, 1200, 700]) add(0, bp, 210, "normal");
  add(1, 7500, 190, "normal");
  add(1, 4200, 190, "normal");
  add(1, 2600, 430, "saturated", 2.2, 3.6);
  add(1, 1500, 190, "normal");
  add(2, 5200, 216, "tailing", 2.2, 8);
  add(2, 900, 190, "normal");
  for (const bp of [10000, 7000, 5000, 3500, 2500, 1800, 1200, 700]) add(3, bp, bp === 2500 ? 150 : 210, "normal");
  add(4, 3400, 150, "overlap-a");
  add(4, 2900, 150, "overlap-b");
  add(4, 1200, 190, "normal");
  add(5, 6400, 200, "normal");
  add(5, 5600, 38, "faint");
  add(5, 250, 180, "normal");
  return out;
}

function renderPng(bands: DrawnBand[]): Buffer {
  const rand = mulberry32(20260919);
  const png = new PNG({ width: W, height: H });
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 10 + (rand() - 0.5) * 6;
      for (let lane = 0; lane < SEED_XS.length; lane++) {
        const cx = centerXAtY(SEED_XS[lane] as number, y);
        v += 26 * Math.exp(-((x - cx) ** 2) / (2 * 13 * 13));
      }
      const idx = (y * W + x) * 4;
      png.data[idx] = Math.round(clamp(v));
      png.data[idx + 1] = Math.round(clamp(v));
      png.data[idx + 2] = Math.round(clamp(v));
      png.data[idx + 3] = 255;
    }
  }
  for (const b of bands) {
    const sigmaX = 6;
    for (let y = Math.floor(b.cy - 4 * b.sigmaYDown); y <= Math.ceil(b.cy + 4 * b.sigmaYDown); y++) {
      if (y < 0 || y >= H) continue;
      const sy = y < b.cy ? b.sigmaYUp : b.sigmaYDown;
      for (let x = Math.floor(b.cx - 3 * sigmaX); x <= Math.ceil(b.cx + 3 * sigmaX); x++) {
        if (x < 0 || x >= W) continue;
        const v = b.amp * Math.exp(-(((x - b.cx) ** 2) / (2 * sigmaX * sigmaX) + ((y - b.cy) ** 2) / (2 * sy * sy)));
        const idx = (y * W + x) * 4;
        const next = clamp((png.data[idx] as number) + v);
        png.data[idx] = next;
        png.data[idx + 1] = next;
        png.data[idx + 2] = next;
      }
    }
  }
  return PNG.sync.write(png);
}

function buildManifest(png: Buffer, bands: DrawnBand[]): CasePackManifest {
  const lanes = SEED_XS.map((seedX, ordinal) => {
    const polyline: { x: number; y: number }[] = [];
    for (let y = 0; y < H; y += 4) polyline.push({ x: centerXAtY(seedX, y), y });
    return { ordinal, role: ROLES[ordinal] as "ladder" | "sample", seedX, halfWidth: 12, polyline };
  });
  const gtBands: GroundTruthBand[] = bands.map((b) => ({
    laneOrdinal: b.laneOrdinal,
    nominal: b.nominal,
    center: { x: Math.round(b.cx * 10) / 10, y: Math.round(b.cy * 10) / 10 },
    kind: b.kind
  }));
  const satBand = bands.find((b) => b.laneOrdinal === 1 && b.kind === "saturated")!;
  const faintBand = bands.find((b) => b.laneOrdinal === 5 && b.kind === "faint")!;
  const manualRevisions: ManualRevisionSpec[] = [
    {
      type: "revise-center",
      laneOrdinal: 1,
      at: { x: Math.round(satBand.cx), y: Math.round(satBand.cy) },
      center: { x: Math.round(satBand.cx), y: Math.round(satBand.cy + 2) },
      widthPx: 24,
      heightPx: 9,
      reason: "人工修订：饱和峰顶削平，审阅者将中心下移 2px，区间结论保留"
    },
    {
      type: "add-band",
      laneOrdinal: 5,
      at: { x: SEED_XS[5] as number, y: Math.round(faintBand.cy) },
      center: { x: Math.round(faintBand.cx), y: Math.round(faintBand.cy) },
      widthPx: 24,
      heightPx: 6,
      reason: "人工补充：5600 bp 弱带低于自动阈值，审阅者手动加入，标为候选"
    }
  ];

  const scenarios: CasePackScenarioSpec[] = [
    {
      id: "baseline",
      title: "基线导入：像素级来源核对",
      description: "原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心均保留像素级来源；自动候选与人工修订并存。",
      kind: "assert",
      mutate: null,
      expect: { evidenceCodes: [EVIDENCE_CODES.LOCAL_RULER_VALID_REGION] }
    },
    {
      id: "curved-smile",
      title: "弯曲泳道：同一高度≠同一分子量",
      description: "微笑弯曲使两个样品泳道在同一画面高度对应不同弧长与不同分子量，必须使用各自局部标尺与有效区域。",
      kind: "assert",
      mutate: null,
      expect: { evidenceCodes: [EVIDENCE_CODES.SMILE_SAME_HEIGHT_DIFFERENT_MW, EVIDENCE_CODES.LOCAL_RULER_VALID_REGION] }
    },
    {
      id: "saturation-overlap-tail",
      title: "饱和区 / 重叠双峰 / 拖尾",
      description: "饱和条带只能给区间；重叠双峰保留组内全部候选；拖尾条带降级为候选。",
      kind: "assert",
      mutate: null,
      expect: {
        evidenceCodes: [
          EVIDENCE_CODES.SATURATED_BAND_CANDIDATE_OR_INTERVAL,
          EVIDENCE_CODES.OVERLAPPING_BANDS_CANDIDATES,
          EVIDENCE_CODES.TAILING_BAND_CANDIDATE
        ]
      }
    },
    {
      id: "param-revision",
      title: "参数修订：饱和阈值 255→250",
      description: "仅修改规则参数版本；旧计算保留内容寻址身份，新计算记录父级依赖与参数版本。",
      kind: "mutate",
      mutate: { type: "param-revision", patch: { saturationIntensity: 250 } },
      expect: { evidenceCodes: [EVIDENCE_CODES.SATURATED_BAND_CANDIDATE_OR_INTERVAL] }
    },
    {
      id: "rotate",
      title: "旋转图像：90° 顺时针派生帧",
      description: "只改动拍摄方向这一直接来源，派生旋转图像、泳道曲线与条带中心，原图与变换来源保留。",
      kind: "mutate",
      mutate: { type: "rotate", clockwiseDegrees: 90 },
      expect: { evidenceCodes: [EVIDENCE_CODES.ROTATED_FRAME_PROVENANCE] }
    },
    {
      id: "missing-band",
      title: "ladder 缺带：撤回 5000 bp 直接来源",
      description: "只撤回 ladder 第 3 档条带材料；跨接区间内推断降级为候选且不确定度扩大，其他标尺不变。",
      kind: "mutate",
      mutate: { type: "missing-band", ladderLaneOrdinal: 0, nominal: "5000 bp" },
      expect: { evidenceCodes: [EVIDENCE_CODES.LADDER_MISSING_BAND_GAP], unchangedFitLaneOrdinals: [3] }
    },
    {
      id: "nonmonotonic",
      title: "非单调标尺：标称值修订冲突",
      description: "为 ladder#3 引入冲突的标称规格（第 4 档 2000 bp，低于下一档 2500 bp），其标尺出现非单调段，段内推断 indeterminate 并保留全部合法候选；ladder#0 不受影响。",
      kind: "mutate",
      mutate: { type: "nonmonotonic-spec", badOrdinal: 4, badNominal: "2000 bp" },
      expect: { evidenceCodes: [EVIDENCE_CODES.NONMONOTONIC_RULER_SEGMENT] }
    },
    {
      id: "local-revision",
      title: "修订后局部失效：移动 ladder 第 2 档中心",
      description: "只修订 ladder#0 的 7000 bp 条带中心（+5px），仅其 fit 与下游泳道校准身份改变，ladder#3 保持不变。",
      kind: "mutate",
      mutate: { type: "local-revision", ladderLaneOrdinal: 0, nominal: "7000 bp", shiftArcPx: 5 },
      expect: { changedFitLaneOrdinals: [0], unchangedFitLaneOrdinals: [3], evidenceCodes: [EVIDENCE_CODES.REVISION_LOCAL_INVALIDATION] }
    },
    {
      id: "conflict",
      title: "互相冲突的人工决定：双分支保留",
      description: "main 分支接受重叠候选值，reviewer-b 分支否定；两个分支与各自可见结论都保留，不互相覆盖。",
      kind: "mutate",
      mutate: { type: "conflict", inferenceKey: "overlap-a@lane4", branch: "reviewer-b" },
      expect: {}
    }
  ];

  return {
    format: CASE_PACK_FORMAT,
    id: contentId("casepack", { title: "gel-ruler-workbench-v1" }),
    title: "胶道标尺：电泳条带、泳道弯曲与分子量校准工作台",
    domain: "gel-electrophoresis",
    narrative:
      "分子实验室对原始凝胶图像标出 ladder、lane 与 band，比较自动候选与人工修订后的分子量推断。基线保留全部像素级来源；随后依次触发旋转、弯曲泳道、ladder 缺带、饱和区、两条带重叠、非单调标尺与修订后局部失效，审阅者可沿证据往返并回溯任意历史版本。",
    image: { file: "gel-case-pack.png", sha256: sha256Hex(png), width: W, height: H, capturedAt: CAPTURED_AT },
    orientation: { clockwiseDegrees: "0 deg", timeBase: "拍摄时钟 Asia/Tokyo，方向基准为图像像素左上角" },
    exposure: {
      exposureDuration: "250 ms",
      gainRaw: "high（原始表示保留）",
      saturationLevelRaw: "255",
      pixelValueRange: [0, 255],
      coordinateBasis: "像素坐标，原点在原图左上角，x 向右、y 向下（迁移方向）"
    },
    ladderSpec: {
      name: "1kb DNA Ladder（案例包标称）",
      dimension: "mass-fragment",
      bands: [
        { ordinal: 1, present: true, nominal: "10000 bp" },
        { ordinal: 2, present: true, nominal: "7000 bp" },
        { ordinal: 3, present: true, nominal: "5000 bp" },
        { ordinal: 4, present: true, nominal: "3500 bp" },
        { ordinal: 5, present: true, nominal: "2500 bp" },
        { ordinal: 6, present: true, nominal: "1800 bp" },
        { ordinal: 7, present: true, nominal: "1200 bp" },
        { ordinal: 8, present: true, nominal: "700 bp" },
        { ordinal: 9, present: true, nominal: "约500" }
      ]
    },
    groundTruth: { lanes, bands: gtBands },
    manualRevisions,
    scenarios
  };
}

export function buildCasePack(targetDir: string): { manifest: CasePackManifest; png: Buffer } {
  mkdirSync(targetDir, { recursive: true });
  const bands = buildBands();
  const png = renderPng(bands);
  const manifest = buildManifest(png, bands);
  writeFileSync(path.join(targetDir, "gel-case-pack.png"), png);
  writeFileSync(path.join(targetDir, "gel-case-pack.json"), JSON.stringify(manifest, null, 2));
  return { manifest, png };
}

