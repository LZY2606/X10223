// ladder 配准：单调动态规划，把观测带与标称档对齐；允许缺带，拒绝非单调标尺。
import type { Diagnostic, LadderRung } from "./types";
import type { DetectedRungView } from "./artifacts";

export interface ObservedBandLite {
  s: number;
  saturated: boolean;
  bandId?: string;
}

export interface AlignmentOutcome {
  valid: boolean;
  rungs: DetectedRungView[];
  diagnostics: Diagnostic[];
  candidateAlignments?: { rungs: DetectedRungView[]; cost: number }[];
  ambiguous: boolean;
}

/** 标称分子量须随迁移距离严格递减（order 越大、分子量越小） */
export function nominalDaOrdered(rungs: LadderRung[]): { values: number[]; diagnostic?: Diagnostic } {
  const ordered = [...rungs].sort((a, b) => a.order - b.order);
  const values: number[] = [];
  let prev = Infinity;
  for (const rung of ordered) {
    const num = Number(/[-+0-9.eE]+/.exec(rung.nominal.raw)?.[0] ?? NaN);
    const label = rung.nominal.unit.label.toLowerCase();
    const scale = label === "kda" ? 1000 : label === "md" ? 1_000_000 : label === "da" ? 1 : NaN;
    if (!Number.isFinite(num) || !Number.isFinite(scale)) {
      return {
        values,
        diagnostic: {
          code: "ladder-nominal-unparseable",
          message: `标称值无法转换：${rung.nominal.raw}（保留原始表示）`,
          severity: "error",
          location: { kind: "rung", field: rung.label }
        }
      };
    }
    const da = num * scale;
    if (da >= prev) {
      return {
        values,
        diagnostic: {
          code: "ladder-non-monotonic",
          message: "ladder 标称值不随迁移单调递减，标尺语义无解",
          severity: "error",
          location: { kind: "rung", field: `${rung.label}(${rung.nominal.raw})` }
        }
      };
    }
    prev = da;
    values.push(da);
  }
  return { values };
}

const INF = 1e18;

interface TraceCell {
  cost: number;
  from: [number, number] | null;
}

function runAlign(observed: ObservedBandLite[], nominalDa: number[], arcLength: number, gapPenalty: number) {
  const n = nominalDa.length;
  const m = observed.length;
  const dp: TraceCell[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => ({ cost: INF, from: null }))
  );
  dp[0][0] = { cost: 0, from: null };
  const logMax = Math.log(nominalDa[0]);
  const logMin = Math.log(nominalDa[n - 1]);
  const predictedS = (i: number) =>
    arcLength * (1 - (Math.log(nominalDa[i]) - logMin) / (logMax - logMin || 1));

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i][j].cost;
      if (cur === INF) continue;
      if (i < n && cur + gapPenalty < dp[i + 1][j].cost) {
        dp[i + 1][j] = { cost: cur + gapPenalty, from: [i, j] };
      }
      if (j < m && cur + gapPenalty * 1.1 < dp[i][j + 1].cost) {
        dp[i][j + 1] = { cost: cur + gapPenalty * 1.1, from: [i, j] };
      }
      if (i < n && j < m) {
        const expected = predictedS(i);
        const match = Math.abs(observed[j].s - expected) / Math.max(1, arcLength);
        const sat = observed[j].saturated ? gapPenalty * 0.05 : 0;
        const cost = match * 6 + sat;
        if (cur + cost < dp[i + 1][j + 1].cost) {
          dp[i + 1][j + 1] = { cost: cur + cost, from: [i, j] };
        }
      }
    }
  }
  return { dp, cost: dp[n][m].cost };
}

function traceback(dp: TraceCell[][], n: number, m: number) {
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const from = dp[i][j].from;
    if (!from) break;
    if (from[0] === i - 1 && from[1] === j - 1) pairs.push([i - 1, j - 1]);
    [i, j] = from;
  }
  pairs.reverse();
  return pairs;
}

function viewsFromPairs(
  pairs: [number, number][],
  rungs: LadderRung[],
  nominalDa: number[],
  observed: ObservedBandLite[]
): DetectedRungView[] {
  const map = new Map(pairs.map(([i, j]) => [i, j]));
  return [...rungs]
    .sort((a, b) => a.order - b.order)
    .map((rung, i) => {
      const j = map.get(i);
      return {
        order: rung.order,
        label: rung.label,
        nominalDa: nominalDa[i],
        s: j === undefined ? null : observed[j].s,
        matched: j !== undefined
      };
    });
}

export function alignLadder(
  rungs: LadderRung[],
  observed: ObservedBandLite[],
  arcLength: number,
  gapPenalty: number
): AlignmentOutcome {
  const ordered = [...rungs].sort((a, b) => a.order - b.order);
  const { values: nominalDa, diagnostic } = nominalDaOrdered(ordered);
  if (diagnostic) {
    return {
      valid: false,
      rungs: ordered.map((r, i) => ({ order: r.order, label: r.label, nominalDa: nominalDa[i] ?? NaN, s: null, matched: false })),
      diagnostics: [diagnostic],
      ambiguous: false
    };
  }
  if (observed.length === 0) {
    return {
      valid: false,
      rungs: ordered.map((r, i) => ({ order: r.order, label: r.label, nominalDa: nominalDa[i], s: null, matched: false })),
      diagnostics: [{ code: "ladder-no-observation", message: "ladder 泳道未检出任何条带", severity: "error" }],
      ambiguous: false
    };
  }

  const primary = runAlign(observed, nominalDa, arcLength, gapPenalty);
  const pairs = traceback(primary.dp, nominalDa.length, observed.length);
  const views = viewsFromPairs(pairs, ordered, nominalDa, observed);
  const diagnostics: Diagnostic[] = [];

  const candidates: { rungs: DetectedRungView[]; cost: number }[] = [{ rungs: views, cost: primary.cost }];
  // 歧义探测：跳过最前/最后观测后代价几乎相同，说明配准不唯一
  for (const sliceObs of [observed.slice(1), observed.slice(0, -1)]) {
    if (sliceObs.length < 2) continue;
    const alt = runAlign(sliceObs, nominalDa, arcLength, gapPenalty);
    if (alt.cost <= primary.cost + gapPenalty * 0.6) {
      const altPairs = traceback(alt.dp, nominalDa.length, sliceObs.length);
      candidates.push({ rungs: viewsFromPairs(altPairs, ordered, nominalDa, sliceObs), cost: alt.cost });
    }
  }
  const ambiguous = candidates.length > 1;
  if (ambiguous) {
    diagnostics.push({ code: "ladder-alignment-ambiguous", message: "存在代价相近的多种 ladder 配准，保留全部合法候选", severity: "warning" });
  }

  const matched = views.filter((v) => v.matched).length;
  if (matched < 2) {
    diagnostics.push({ code: "ladder-insufficient-rungs", message: "可配准 ladder 档不足 2 个，无法建立局部标尺", severity: "error" });
    return { valid: false, rungs: views, diagnostics, ambiguous, candidateAlignments: ambiguous ? candidates : undefined };
  }
  if (views.some((v) => !v.matched)) {
    diagnostics.push({ code: "ladder-missing-rung", message: "存在缺失 ladder 档：相关插值段标注跨缺带区间", severity: "warning" });
  }
  return { valid: true, rungs: views, diagnostics, ambiguous, candidateAlignments: ambiguous ? candidates : undefined };
}
