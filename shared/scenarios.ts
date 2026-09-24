// 八个离线案例：主叙事（含参数修订、局部源改动、冲突决定）+ 七类反例。
import type { Event, GelParams, Material, Vec2 } from "./types";
import { buildCasePack, standardLadder, type CasePack, type PackBuildContext } from "./casepack";
import { defaultParams } from "./defaults";
import { buildCurve, interpAt } from "./curveMath";
import { detectBands } from "./detector";
import { sha256Text } from "./hash";
import { canonicalJson } from "./canonical";
import type { GelGenSpec, GenLane, GenBand } from "./gelgen";
import { laneCenterPoints as laneCenterPointsLazy } from "./gelgen";

const W = 360;
const H = 460;
const WELLS = 40;
const BOTTOM = 24;
const HW = 20;

/** 生成 ladder 条带，omitRungs 用于 ladder 缺带 */
function ladderBands(fracs: number[], opts: { omit?: number[]; saturateAt?: number; tailAt?: number } = {}): GenBand[] {
  const out: GenBand[] = [];
  fracs.forEach((sFrac, i) => {
    if (opts.omit?.includes(i)) return;
    const amp = opts.saturateAt === i ? 300 : 120 + ((i * 37) % 60);
    out.push({ sFrac, amp, sigmaS: 4.2, tail: opts.tailAt === i ? 26 : undefined });
  });
  return out;
}

const LADDER_FRACS = [0.05, 0.14, 0.23, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92];

function baseSpec(over: Partial<GelGenSpec> & { lanes: GenLane[] }): GelGenSpec {
  const { lanes, ...rest } = over;
  return {
    width: W,
    height: H,
    wellsY: WELLS,
    bottomMargin: BOTTOM,
    laneHalfWidth: HW,
    smile: 0,
    bend: 0,
    bg: 18,
    noise: 6,
    seed: 1194,
    ...rest,
    lanes
  };
}

function threeLanes(
  middleBands: GenBand[],
  opts: { smile?: number; bend?: number; seed?: number; ladderOpts?: { omit?: number[]; saturateAt?: number; tailAt?: number }; preRotate?: 0 | 1 | 2 | 3; extra?: Partial<GelGenSpec> } = {}
): GelGenSpec {
  return baseSpec({
    smile: opts.smile ?? 26,
    bend: opts.bend ?? 10,
    seed: opts.seed ?? 1194,
    preRotate: opts.preRotate,
    ...opts.extra,
    lanes: [
      { label: "L-ladder", role: "ladder", xTopFrac: 0.16, bands: ladderBands(LADDER_FRACS, opts.ladderOpts) },
      { label: "S1-sample", role: "sample", xTopFrac: 0.5, bands: middleBands },
      { label: "R-ladder", role: "ladder", xTopFrac: 0.84, bands: ladderBands(LADDER_FRACS, opts.ladderOpts) }
    ]
  });
}

function makeLaneRevision(shift: (p: Vec2) => Vec2) {
  return (ctx: PackBuildContext) => {
    const lane = ctx.lanes[1];
    const updatedCenter = lane.center.map(shift);
    const updated: Material = { ...lane, id: `lane_rev_${sha256Text(canonicalJson({ updatedCenter, parent: lane.id })).slice(0, 12)}`, center: updatedCenter };
    return { changedField: "center", from: lane.center[lane.center.length >> 1], to: updatedCenter[updatedCenter.length >> 1], material: updated };
  };
}

function makeBandRevision(newS: number) {
  return (ctx: PackBuildContext) => {
    const lane = ctx.lanes[1];
    const curve = buildCurve(lane.center);
    const point = interpAt(curve, newS);
    const band = ctx.builder.events
      .map((e) => (e.type === "material_added" && e.payload.material.kind === "band" ? e.payload.material : null))
      .find((m): m is Extract<Material, { kind: "band" }> => !!m && m.laneId === lane.id);
    if (!band) throw new Error("revision target band missing");
    const updated: Material = {
      ...band,
      id: `band_rev_${sha256Text(canonicalJson({ point, parent: band.id })).slice(0, 12)}`,
      center: point,
      provenance: { ...band.provenance, interpretedPixel: point, note: "revised band center (single direct source)" }
    };
    return { changedField: "center", from: band.center, to: point, material: updated };
  };
}

function makeOrientationRevision(toTurns: 0 | 1 | 2 | 3) {
  return (ctx: PackBuildContext) => {
    const old = ctx.materials.orientation;
    const updated: Material = { ...old, id: `ori_rev_${toTurns}`, rotationQuarterTurns: toTurns };
    return { changedField: "rotationQuarterTurns", from: old.rotationQuarterTurns, to: toTurns, material: updated };
  };
}

export function mainNarrativeCase(): CasePack {
  const sampleBands: GenBand[] = [
    { sFrac: 0.3, amp: 150, sigmaS: 4.2 },
    { sFrac: 0.66, amp: 140, sigmaS: 4.2 }
  ];
  const spec = threeLanes(sampleBands, { smile: 30, bend: 12, seed: 77 });

  const v2: GelParams = {
    ...defaultParams(),
    version: "rules/gel/v2",
    bandDetection: { ...defaultParams().bandDetection, minProminence: 20 },
    saturation: { ...defaultParams().saturation, plateauRatio: 0.3 }
  };

  return buildCasePack({
    caseId: "case-narrative",
    title: "胶道标尺：主叙事——自动候选 vs 人工修订的分子量推断",
    scenario: "smile-curved lanes; parameter revision; local-only source change; conflicting manual decisions on a branch",
    tags: ["narrative", "smile", "revision", "conflict", "branch"],
    spec,
    ladderLaneIndexes: [0, 2],
    parameterRevision: { params: v2, reason: "提高最小峰突阈值并收紧饱和平台判据（参数修订，全量重算）" },
    // 只改动一个直接来源：S1 lane 控制点整体平移 5px——仅该 lane 局部依赖失效
    sourceRevision: { kind: "lane", mutate: makeLaneRevision((p) => ({ x: p.x + 5, y: p.y })) },
    forks: [
      {
        name: "review-accept",
        build: (ctx) => {
          const out: Event[] = [];
          const autoKey = findAutoBandKey(ctx, 0.3);
          out.push(ctx.builder.decide({ bandId: autoKey, decision: "accept", reason: "复核：该候选中心与轮廓吻合，接受" }));
          return out;
        }
      },
      {
        name: "review-reject",
        build: (ctx) => {
          const out: Event[] = [];
          const autoKey = findAutoBandKey(ctx, 0.3);
          out.push(ctx.builder.decide({ bandId: autoKey, decision: "reject", reason: "另一审阅者判定为拖尾伪影，否定" }));
          return out;
        }
      }
    ]
  });
}

function findAutoBandKey(ctx: PackBuildContext, sFrac: number): string {
  // 必须与引擎的自动候选稳定身份完全一致：detectBands 中心 + s 四舍五入 + 中心摘要
  const lane = ctx.lanes[1];
  const raster = ctx.image.raster;
  const result = detectBands(raster, lane.center, lane.halfWidth, ctx.params);
  const usable = ctx.image.height - WELLS - BOTTOM;
  const want = sFrac * usable;
  const target = result.bands.reduce((best, b) => (Math.abs(b.s - want) < Math.abs(best.s - want) ? b : best), result.bands[0]);
  return `auto:${lane.logicalId}:${Math.round(target.s)}:${sha256Text(canonicalJson(target.center)).slice(0, 6)}`;
}

// C1 旋转图像：原图相机倒拍 90°，审阅者通过 orientation 修订纠正；原始像素坐标保留
function rotationCase(): CasePack {
  const upright = threeLanes([{ sFrac: 0.45, amp: 150, sigmaS: 4.2 }], { smile: 8, bend: 0, seed: 11 });
  const spec: GelGenSpec = { ...upright, preRotate: 1 };
  const caseId = "case-rotation";
  const explicit = upright.lanes.map((genLane, i) => {
    const center = laneCenterPointsLazy(upright, i);
    const lane: import("./types").LaneMaterial = {
      kind: "lane",
      id: `lane-rot-pending-${i}`,
      logicalId: `lane-${i}`,
      imageId: "",
      index: i,
      role: genLane.role,
      center,
      halfWidth: upright.laneHalfWidth,
      label: genLane.label,
      provenance: center
        .filter((_, k) => k % 8 === 0)
        .map((p) => ({ sourceImageId: "", originalPixel: rotateInterpretedToOriginal(p, 1, upright.width, upright.height), interpretedPixel: p }))
    };
    return lane;
  });
  return buildCasePack({
    caseId,
    title: "反例：拍摄方向旋转 90°",
    scenario: "原始光栅被相机旋转；orientation=1 使解释帧迁移向下；原图与原始像素不变",
    tags: ["rotation"],
    spec,
    ladderLaneIndexes: [0, 2],
    orientationTurns: 1,
    explicitLanes: explicit,
    sourceRevision: {
      kind: "orientation",
      mutate: makeOrientationRevision(0)
    }
  });
}

function rotateInterpretedToOriginal(p: Vec2, turns: 0 | 1 | 2 | 3, w: number, h: number): Vec2 {
  if (turns === 1) return { x: p.y, y: w - 1 - p.x };
  if (turns === 2) return { x: w - 1 - p.x, y: h - 1 - p.y };
  if (turns === 3) return { x: h - 1 - p.y, y: p.x };
  return p;
}

// C2 弯曲泳道：微笑使同高度不等于同分子量；样道标尺为转移标尺并带公共有效区域
function smileCase(): CasePack {
  const spec = threeLanes(
    [
      { sFrac: 0.25, amp: 150, sigmaS: 4.2 },
      { sFrac: 0.88, amp: 150, sigmaS: 4.2 }
    ],
    { smile: 42, bend: 16, seed: 23 }
  );
  return buildCasePack({
    caseId: "case-smile",
    title: "反例：“微笑”弯曲——同一高度不是同一分子量",
    scenario: "强微笑；中间样道使用左右 ladder 夹逼的局部标尺，有效区域为公共交集",
    tags: ["smile", "curved-lanes", "local-valid-range"],
    spec,
    ladderLaneIndexes: [0, 2]
  });
}

// C3 ladder 缺带：右侧 ladder 缺第 3、6 档；跨缺带段只能给区间，其余不受影响
function missingRungCase(): CasePack {
  const spec = baseSpec({
    lanes: [
      { label: "ladder-complete", role: "ladder", xTopFrac: 0.22, bands: ladderBands(LADDER_FRACS) },
      { label: "sample", role: "sample", xTopFrac: 0.5, bands: [{ sFrac: 0.58, amp: 150, sigmaS: 4.2 }] },
      {
        label: "ladder-missing",
        role: "ladder",
        xTopFrac: 0.78,
        bands: ladderBands(LADDER_FRACS, { omit: [3, 6] })
      }
    ]
  });
  return buildCasePack({
    caseId: "case-missing-rung",
    title: "反例：ladder 缺带",
    scenario: "一 ladder 缺两档：缺失段内推断为区间，缺带之外分段保持精确",
    tags: ["missing-rung", "interval"],
    spec,
    ladderLaneIndexes: [0, 2]
  });
}

// C4 饱和区：样带削顶平台，只能报告区间候选
function saturationCase(): CasePack {
  const spec = threeLanes(
    [
      { sFrac: 0.4, amp: 320, sigmaS: 6 },
      { sFrac: 0.7, amp: 140, sigmaS: 4.2 }
    ],
    { smile: 10, bend: 4, seed: 31 }
  );
  return buildCasePack({
    caseId: "case-saturation",
    title: "反例：饱和条带（强度平台削顶）",
    scenario: "一条样带饱和：中心不可信，只允许区间；另一带仍可唯一推断",
    tags: ["saturation", "interval"],
    spec,
    ladderLaneIndexes: [0, 2]
  });
}

// C5 两条带重叠：近邻双峰，保留全部合法候选
function overlapCase(): CasePack {
  const spec = threeLanes(
    [
      { sFrac: 0.5, amp: 150, sigmaS: 4.6 },
      { sFrac: 0.565, amp: 140, sigmaS: 4.6 }
    ],
    { smile: 8, bend: 2, seed: 41 }
  );
  return buildCasePack({
    caseId: "case-overlap",
    title: "反例：两条带重叠",
    scenario: "间距小于合并阈值：无法唯一归属，保留全部合法候选",
    tags: ["overlap", "candidates"],
    spec,
    ladderLaneIndexes: [0, 2]
  });
}

// C6 非单调标尺：标称值故意反转；该 ladder 校准语义无解（独立于其他 lane）
function nonMonotonicCase(): CasePack {
  const bad = standardLadder("ladder-case-nonmono");
  const tmp = bad.rungs[3].nominal;
  bad.rungs[3] = { ...bad.rungs[3], nominal: { ...bad.rungs[2].nominal } };
  bad.rungs[2] = { ...bad.rungs[2], nominal: { ...tmp } }; // 交换相邻两档 -> 非单调
  const spec = threeLanes([{ sFrac: 0.45, amp: 150, sigmaS: 4.2 }], { smile: 6, seed: 53 });
  return buildCasePack({
    caseId: "case-non-monotonic",
    title: "反例：非单调 ladder 标尺",
    scenario: "标称分子量不随迁移单调：校准语义无解，返回带位置诊断而非数值",
    tags: ["non-monotonic", "semantic-invalid"],
    spec,
    ladderLaneIndexes: [0, 2],
    ladderSpec: bad
  });
}

// C7 修订后局部失效：把样道 lane 末端控制点拖到 ladder 有效区域之外，仅该 lane 失效
function localInvalidationCase(): CasePack {
  const spec = threeLanes([{ sFrac: 0.95, amp: 150, sigmaS: 4.2 }], { smile: 12, bend: 4, seed: 61 });
  return buildCasePack({
    caseId: "case-local-invalidation",
    title: "反例：修订后局部失效",
    scenario: "仅修订一条 lane 的单个控制点，使深迁移带超出有效区域；其他 lane 结论不变",
    tags: ["local-invalidation", "dependency-scope"],
    spec,
    ladderLaneIndexes: [0, 2],
    sourceRevision: {
      kind: "lane",
      mutate: makeLaneRevision((p) => (p.y > 380 ? { x: p.x, y: p.y + 26 } : p))
    }
  });
}

export function allCasePacks(): CasePack[] {
  return [
    mainNarrativeCase(),
    rotationCase(),
    smileCase(),
    missingRungCase(),
    saturationCase(),
    overlapCase(),
    nonMonotonicCase(),
    localInvalidationCase()
  ];
}
