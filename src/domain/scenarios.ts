import type { BandCenter, CaptureOrientation, Material } from './types.ts';

/** Counterexample archive: from a frozen baseline, each scenario changes
 *  exactly ONE direct source so the blast radius of the change can be
 *  checked against the dependency graph. */

export const SCENARIOS = [
  'rotated_image',
  'curved_lanes',
  'ladder_missing_band',
  'saturated_region',
  'overlapping_bands',
  'non_monotonic_ruler',
  'revision_local_invalidation',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioSpec {
  name: ScenarioName;
  title: string;
  changes_one_source: string;
  expect: string;
}

export const SCENARIO_SPECS: ScenarioSpec[] = [
  { name: 'rotated_image', title: '旋转图像', changes_one_source: 'capture_orientation + gel_image',
    expect: '方向材料变更使依赖它的派生结果失效；用变换后坐标重算则分子量保持一致' },
  { name: 'curved_lanes', title: '弯曲泳道（微笑）', changes_one_source: 'gel_image.smile_k',
    expect: '同一高度不等于同一分子量；每条泳道得到带有效区域的局部标尺' },
  { name: 'ladder_missing_band', title: 'ladder 缺带', changes_one_source: 'band_centers(lane-0)',
    expect: '缺带所在插值段只能给出区间估计' },
  { name: 'saturated_region', title: '饱和区', changes_one_source: 'gel_image pixels',
    expect: '饱和条带只能标为候选或区间' },
  { name: 'overlapping_bands', title: '两条带重叠', changes_one_source: 'band_centers(lane-N)',
    expect: '重叠条带只能给出区间并保留全部合法候选' },
  { name: 'non_monotonic_ruler', title: '非单调标尺', changes_one_source: 'band_centers(lane-0)',
    expect: '结果必须是 semantically_unsolvable，且与预算耗尽、格式损坏相区分' },
  { name: 'revision_local_invalidation', title: '修订后局部失效', changes_one_source: 'band_centers(lane-3)',
    expect: '只有依赖被改材料的派生结果失效，其余泳道结果保持有效' },
];

/** Rotate a grayscale image 180° and transform band centers accordingly. */
export function rotate180(
  pixels: Uint8Array, width: number, height: number,
): { pixels: Uint8Array; transform: (x: number, y: number) => { x: number; y: number } } {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(height - 1 - y) * width + (width - 1 - x)] = pixels[y * width + x];
    }
  }
  return { pixels: out, transform: (x, y) => ({ x: width - 1 - x, y: height - 1 - y }) };
}

export function transformCenters(
  centers: BandCenter[], fn: (x: number, y: number) => { x: number; y: number },
): BandCenter[] {
  return centers.map((c) => {
    const p = fn(c.x, c.y);
    return { ...c, x: p.x, y: p.y };
  });
}

export function orientationAfter180(o: CaptureOrientation): CaptureOrientation {
  return { rotation_deg: ((o.rotation_deg + 180) % 360) as CaptureOrientation['rotation_deg'], wells: o.wells === 'top' ? 'bottom' : 'top' };
}

/** Look up the current material per (kind,label). */
export function currentMaterials(materials: Material[]): Map<string, Material> {
  const map = new Map<string, Material>();
  for (const m of materials) {
    const key = `${m.kind}:${m.label}`;
    const prev = map.get(key);
    if (!prev || m.seq > prev.seq) map.set(key, m);
  }
  return map;
}
