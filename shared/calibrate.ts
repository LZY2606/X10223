import type {
  CalibrationRungResult, CalibrationSegment, Derivation, DerivationBandMW,
  DerivationCalibration, Diagnostic, MaterialBandCenter, MaterialLadderSpec,
  MaterialLaneBoundary, MWCandidate, ValidRegion,
} from './types.js';
import { RULE_VERSION } from './types.js';
import { contentId, sha256Hex } from './hash.js';

export interface CalibrateParams {
  paramsVersion: string;
  /** 允许缺带数（DP 弹性）。 */
  maxMissingRungs: number;
  /** 同一弧长上允许的歧义匹配数（保留全部合法候选）。 */
  keepCandidates: number;
  /** 插值段有效所需最小相邻档数。 */
  minRungsPerSegment: number;
  /** 曲率警告阈值 px（局部失效依据）。 */
  curvatureLimitPx: number;
}

export const DEFAULT_CALIBRATE_PARAMS: CalibrateParams = {
  paramsVersion: 'params:v1',
  maxMissingRungs: 2,
  keepCandidates: 2,
  minRungsPerSegment: 2,
  curvatureLimitPx: 12,
};

function diag(d: Diagnostic): Diagnostic { return d; }

function spineDeviation(lane: MaterialLaneBoundary): number {
  // 中脊相对首末点直线的最大横向偏差（px），用于弯曲/局部失效。
  const a = lane.spine[0]; const b = lane.spine[lane.spine.length - 1];
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let max = 0;
  for (const p of lane.spine) {
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
    const qx = a.x + t * dx; const qy = a.y + t * dy;
    max = Math.max(max, Math.hypot(p.x - qx, p.y - qy));
  }
  return max;
}

/**
 * ladder 档（标称，降序质量，自上而下）与检测条带（按弧长升序）做弹性匹配。
 * 使用动态规划，允许缺带；非单调/倒序通过 monotonic 参数检测。
 * 返回全部最优匹配（保留合法候选），而不是强行选一个。
 */
interface MatchCell {
  cost: number;
  rung: number; // rung 下标
  band: number; // band 下标，-1 表示该档缺带
  prev: number; // 前一 cell 索引
  id: number;
}

export interface LadderMatch {
  /** rung 下标 -> band 下标（-1 缺带） */
  assignment: number[];
  cost: number;
}

function logMass(v: number): number { return Math.log10(Math.max(1e-9, v)); }

export function matchLadder(
  spec: MaterialLadderSpec,
  bands: MaterialBandCenter[],
): { matches: LadderMatch[]; nonMonotonic: boolean; inversionAt: string | null } {
  const rungs = spec.rungs; // 标称降序
  let nonMonotonic = false;
  let inversionAt: string | null = null;
  for (let i = 1; i < rungs.length; i++) {
    if (rungs[i].nominal.value >= rungs[i - 1].nominal.value) {
      nonMonotonic = true; inversionAt = rungs[i].rungId;
    }
  }
  const sortedBands = [...bands].sort((a, b) => a.arcLength.value - b.arcLength.value);
  const m = rungs.length; const n = sortedBands.length;

  // 非单调标尺：匹配无意义，返回缺省并在调用处失败
  if (nonMonotonic) {
    return { matches: [{ assignment: rungs.map(() => -1), cost: Infinity }], nonMonotonic, inversionAt };
  }

  // DP：按 rung 推进，band 单调；允许跳过 band（杂带）与跳过 rung（缺带，<=maxMissing）
  const cells: MatchCell[] = [];
  let cellId = 0;
  // dp[r][j]：处理到第 r 个 rung 且该 rung 用第 j 个 band（j=-1 缺带）时的最佳 cell
  const dp: Map<string, number> = new Map();
  const key = (r: number, j: number) => `${r}:${j}`;
  const missingCost = 40;
  const skipBandPenalty = 8;

  for (let r = 0; r < m; r++) {
    const options: { j: number; cost: number }[] = [{ j: -1, cost: missingCost }];
    for (let j = 0; j < n; j++) options.push({ j, cost: 0 });
    for (const opt of options) {
      let best: { cost: number; prev: number } | null = null;
      if (r === 0) {
        let cost = opt.cost + (opt.j > 0 ? skipBandPenalty * opt.j : 0);
        best = { cost, prev: -1 };
      } else {
        // 枚举上一层 cell
        for (const [pk, pid] of dp) {
          const [pr, pjStr] = pk.split(':');
          if (Number(pr) !== r - 1) continue;
          const prev = cells[pid];
          const pj = prev.band;
          if (opt.j !== -1 && opt.j <= pj) continue; // 弧长单调
          let extra = opt.cost;
          if (opt.j !== -1 && pj !== -1) {
            // 与 log 质量比 vs 弧长比的单调性一致性（软代价）
            const expected = logMass(rungs[r - 1].nominal.value) - logMass(rungs[r].nominal.value);
            const ds = sortedBands[opt.j].arcLength.value - sortedBands[pj].arcLength.value;
            if (ds <= 0) extra += 1e6;
            else extra += Math.abs(Math.log(ds / Math.max(1, expected * 60 + 1e-6)));
          }
          const missingSoFar = countMissing(prev, r - 1);
          if (opt.j === -1 && missingSoFor(prev) >= DEFAULT_CALIBRATE_PARAMS.maxMissingRungs) continue;
          const total = prev.cost + extra;
          if (!best || total < best.cost) best = { cost: total, prev: pid };
        }
      }
      if (best) {
        const id = cellId++;
        cells.push({ cost: best.cost, rung: r, band: opt.j, prev: best.prev, id });
        const cur = dp.get(key(r, opt.j));
        if (cur === undefined || cells[cur].cost > best.cost) dp.set(key(r, opt.j), id);
      }
    }
  }
  void missingCost;
  function countMissing(_cell: MatchCell, _r: number): number { return 0; }
  function missingSoFor(cell: MatchCell): number {
    let c = cell; let cnt = 0;
    while (true) {
      if (c.band === -1) cnt++;
      if (c.prev === -1) break;
      c = cells[c.prev];
    }
    return cnt;
  }

  // 取终止层代价最低的若干匹配（保留候选）
  const ends: MatchCell[] = [];
  for (const [pk, pid] of dp) {
    const [pr] = pk.split(':').map(Number);
    if (pr === m - 1) ends.push(cells[pid]);
  }
  ends.sort((a, b) => a.cost - b.cost);
  const tolerance = 2.0;
  const bestCost = ends[0]?.cost ?? 0;
  const chosen = ends.filter((e) => e.cost <= bestCost + tolerance).slice(0, DEFAULT_CALIBRATE_PARAMS.keepCandidates);
  const matches: LadderMatch[] = chosen.map((end) => {
    const assignment = new Array(m).fill(-1);
    let c: MatchCell | undefined = end;
    let skippedTail = 0;
    const lastBand = end.band;
    while (c) {
      assignment[c.rung] = c.band;
      c = c.prev === -1 ? undefined : cells[c.prev];
    }
    if (lastBand >= 0) skippedTail = (n - 1) - lastBand;
    return { assignment, cost: end.cost + skippedTail * skipBandPenalty };
  });
  if (!matches.length && n >= 2) return { matches: [{ assignment: rungs.map(() => -1), cost: Infinity }], nonMonotonic, inversionAt };
  if (!matches.length) return { matches: [{ assignment: rungs.map(() => -1), cost: Infinity }], nonMonotonic, inversionAt };
  return { matches, nonMonotonic, inversionAt };
}
