import type { Diagnostic } from './core';

/** ladder 标称值（原始表示保留，派生层才解析） */
export interface NominalEntry {
  nominalId: string;
  raw: string;
  mwBp: number | null; // 无法解析时保持 null 并附诊断，不用默认值伪装
}

export interface ObservedLadderBand {
  bandId: string;
  y: number;
}

export interface LadderMatch {
  pairs: { nominalId: string; bandId: string; y: number; mwBp: number }[];
  missing: { nominalId: string; mwBp: number }[];
  diagnostics: Diagnostic[];
}

function linearFitSSE(ys: number[], logs: number[]): number {
  const n = ys.length;
  const sx = ys.reduce((a, b) => a + b, 0);
  const sy = logs.reduce((a, b) => a + b, 0);
  const sxx = ys.reduce((a, b) => a + b * b, 0);
  const sxy = ys.reduce((a, b) => a + b * logs[ys.indexOf(b)], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return Number.POSITIVE_INFINITY;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  if (slope >= 0) return Number.POSITIVE_INFINITY; // 分子量必须随 y 下降
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = logs[i] - (slope * ys[i] + intercept);
    sse += r * r;
  }
  return sse;
}

function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < n; i++) yield* combinations(n, k, i + 1, [...prefix, i]);
}

/**
 * 标称值与观测条带对齐，支持 ladder 缺带。
 * 策略：枚举“哪些标称值缺失”，取 logMw~y 线性拟合残差最小且单调下降的对齐。
 * 组合数超预算时退化为顺序对齐并附诊断。未匹配标称记入 missing 并附位置诊断。
 */
export function matchLadder(nominals: NominalEntry[], observed: ObservedLadderBand[], ladderId: string, comboBudget = 500): LadderMatch {
  const diagnostics: Diagnostic[] = [];
  const usable = nominals.filter((n) => n.mwBp !== null && (n.mwBp as number) > 0);
  for (const n of nominals) {
    if (n.mwBp === null || !(n.mwBp > 0)) {
      diagnostics.push({
        code: 'NOMINAL_UNPARSEABLE',
        message: `ladder 标称值无法解析：${JSON.stringify(n.raw)}（保留在原位置，不参与拟合）`,
        location: { objectType: 'ladder_nominal', objectId: n.nominalId, field: 'raw' },
      });
    }
  }
  const nom = [...usable].sort((a, b) => (b.mwBp as number) - (a.mwBp as number)); // 大分子量在上
  const obs = [...observed].sort((a, b) => a.y - b.y);
  const n = nom.length;
  const m = obs.length;
  if (n === 0 || m === 0) {
    return { pairs: [], missing: nom.map((e) => ({ nominalId: e.nominalId, mwBp: e.mwBp as number })), diagnostics };
  }
  if (m >= n) {
    const k = Math.min(n, m);
    const pairs = Array.from({ length: k }, (_, i) => ({ nominalId: nom[i].nominalId, bandId: obs[i].bandId, y: obs[i].y, mwBp: nom[i].mwBp as number }));
    const matched = new Set(pairs.map((p) => p.nominalId));
    const missing = nom.filter((e) => !matched.has(e.nominalId)).map((e) => ({ nominalId: e.nominalId, mwBp: e.mwBp as number }));
    return { pairs, missing, diagnostics };
  }
  // 枚举选择 m 个标称与 m 条观测顺序对齐
  let combos = 0;
  let best: { idx: number[]; sse: number } | null = null;
  let overflow = false;
  for (const idx of combinations(n, m)) {
    combos++;
    if (combos > comboBudget) {
      overflow = true;
      break;
    }
    const ys = idx.map((_, j) => obs[j].y);
    const logs = idx.map((i) => Math.log10(nom[i].mwBp as number));
    const sse = linearFitSSE(ys, logs);
    if (best === null || sse < best.sse) best = { idx, sse };
  }
  if (overflow || best === null) {
    diagnostics.push({
      code: 'LADDER_ALIGN_FALLBACK',
      message: `ladder 对齐组合数超预算（>${comboBudget}），退化为顺序对齐`,
      location: { objectType: 'ladder', objectId: ladderId },
    });
    const pairs = obs.map((o, j) => ({ nominalId: nom[j].nominalId, bandId: o.bandId, y: o.y, mwBp: nom[j].mwBp as number }));
    const matched = new Set(pairs.map((p) => p.nominalId));
    const missing = nom.filter((e) => !matched.has(e.nominalId)).map((e) => ({ nominalId: e.nominalId, mwBp: e.mwBp as number }));
    return { pairs, missing, diagnostics };
  }
  const pairs = best.idx.map((i, j) => ({ nominalId: nom[i].nominalId, bandId: obs[j].bandId, y: obs[j].y, mwBp: nom[i].mwBp as number }));
  const matched = new Set(pairs.map((p) => p.nominalId));
  const missing = nom.filter((e) => !matched.has(e.nominalId)).map((e) => ({ nominalId: e.nominalId, mwBp: e.mwBp as number }));
  for (const miss of missing) {
    diagnostics.push({
      code: 'LADDER_BAND_MISSING',
      message: `ladder 缺带：标称 ${miss.mwBp} bp 无对应观测条带，该点不参与拟合`,
      location: { objectType: 'ladder_nominal', objectId: miss.nominalId },
    });
  }
  return { pairs, missing, diagnostics };
}
