/**
 * 边界情形重放：旋转图像、弯曲泳道、ladder 缺带、饱和区、两条带重叠、
 * 非单调标尺、修订后局部失效。每个情形只改动一个直接来源，
 * 事件记录输入片段、判定状态与受影响对象，重计算自动限定在依赖范围内。
 */
import { canonical, contentId, sha256 } from '../shared/ids.js';
import { rotatePoint90 } from '../shared/geometry.js';
import { MW_PARAMS_V2 } from '../shared/infer.js';
import type {
  BandObject,
  GelImageObject,
  LaneObject,
  LadderObject,
  PixelBasis,
  PixelPoint
} from '../shared/types.js';
import type { GelStore } from './db.js';
import { recomputeMW } from './recompute.js';
import { judgment } from './seed.js';

function rehash<T extends { hash: string }>(obj: T): T {
  obj.hash = sha256(canonical({ ...obj, hash: '' }));
  return obj;
}

function mapPoints(points: PixelPoint[], fn: (p: PixelPoint) => PixelPoint): PixelPoint[] {
  return points.map(fn);
}

/** 1. 旋转图像：只改图像来源，坐标系重定基，分子量结论应保持不变。 */
export function scenarioRotateImage(store: GelStore): void {
  const image = store.objects('gel-image', { currentOnly: true })[0].data as GelImageObject;
  const src = Buffer.from(image.pixelsB64, 'base64');
  const W = image.width;
  const H = image.height;
  const dst = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = W - 1 - y;
      const ny = x;
      dst[ny * H + nx] = src[y * W + x];
    }
  }
  const newImage = rehash<GelImageObject>({
    ...image,
    id: contentId('img', { prev: image.id, change: 'rotate90' }),
    width: H,
    height: W,
    pixelsB64: dst.toString('base64'),
    orientationDeg: 90
  });
  store.supersedeObject(image.id, newImage);

  const basis: PixelBasis = 'image-rotated-90';
  const rot = (p: PixelPoint): PixelPoint => ({ ...rotatePoint90(p, W), basis });
  const affected: string[] = [newImage.id];

  for (const stored of store.objects('lane', { currentOnly: true })) {
    const lane = stored.data as LaneObject;
    const next = rehash<LaneObject>({
      ...lane,
      id: contentId('lane', { prev: lane.id, change: 'rotate90' }),
      centerline: mapPoints(lane.centerline, rot),
      leftEdge: mapPoints(lane.leftEdge, rot),
      rightEdge: mapPoints(lane.rightEdge, rot),
      source: { sourceEventId: lane.source.sourceEventId, note: `${lane.source.note ?? ''}；坐标经 90° 旋转重定基` }
    });
    store.supersedeObject(lane.id, next);
    affected.push(next.id);
  }
  const ladder = store.objects('ladder', { currentOnly: true })[0].data as LadderObject;
  const laneIdMap = new Map<string, string>();
  for (const stored of store.objects('lane')) {
    // 旧 -> 新 映射
  }
  const currentLanes = store.objects('lane', { currentOnly: true }).map((o) => o.data as LaneObject);
  const newLadderLane = currentLanes.find((l) => l.index === 0 && l.role === 'ladder')!;
  const newLadder = rehash<LadderObject>({
    ...ladder,
    id: contentId('ladder', { prev: ladder.id, change: 'rotate90' }),
    laneId: newLadderLane.id,
    points: ladder.points.map((p) => ({
      ...p,
      id: contentId('ldp', { prev: p.id, change: 'rotate90' }),
      center: rot(p.center)
    }))
  });
  store.supersedeObject(ladder.id, newLadder);
  affected.push(newLadder.id);

  for (const stored of store.objects('band', { currentOnly: true })) {
    const band = stored.data as BandObject;
    const newLane = currentLanes.find((l) => l.index === (store.objectById<LaneObject>(band.laneId)?.index ?? -1));
    const next = rehash<BandObject>({
      ...band,
      id: contentId('band', { prev: band.id, change: 'rotate90' }),
      laneId: newLane ? newLane.id : band.laneId,
      center: rot(band.center),
      contour: mapPoints(band.contour, rot),
      source: { sourceEventId: band.source.sourceEventId, note: `${band.source.note ?? ''}；坐标经 90° 旋转重定基` }
    });
    store.supersedeObject(band.id, next);
    affected.push(next.id);
  }
  void laneIdMap;

  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.image-rotated',
    judgment(
      'provenance/rebase-coordinates',
      '图像旋转 90°：所有像素坐标重定基到 image-rotated-90，来源链保留',
      [image.id],
      [...affected, ...r.inserted.map((c) => c.id)],
      true,
      'rotate-90-rebase',
      { fragment: { orientationDeg: 90, width: H, height: W }, status: 'rebased', recomputed: r.inserted.length }
    ),
    [image.id]
  );
}

/** 2. 弯曲泳道：只改泳道几何来源。 */
export function scenarioCurveLanes(store: GelStore, bendAmpTo = 16): void {
  const lanes = store.objects('lane', { currentOnly: true }).map((o) => o.data as LaneObject);
  const affected: string[] = [];
  for (const lane of lanes) {
    const n = lane.centerline.length - 1;
    const next = rehash<LaneObject>({
      ...lane,
      id: contentId('lane', { prev: lane.id, change: `bend-${bendAmpTo}` }),
      centerline: lane.centerline.map((p, i) => {
        const t = i / n;
        return { ...p, x: Math.round((p.x + bendAmpTo * Math.sin(Math.PI * t)) * 100) / 100 };
      }),
      source: { sourceEventId: lane.source.sourceEventId, note: `泳道弯曲修订 bendAmp->${bendAmpTo}px` }
    });
    next.leftEdge = next.centerline.map((p) => ({ ...p, x: Math.round((p.x - 11) * 100) / 100 }));
    next.rightEdge = next.centerline.map((p) => ({ ...p, x: Math.round((p.x + 11) * 100) / 100 }));
    store.supersedeObject(lane.id, next);
    affected.push(next.id);
  }
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.lanes-curved',
    judgment(
      'geometry/smile-local-scale',
      '“微笑”弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域',
      lanes.map((l) => l.id),
      [...affected, ...r.inserted.map((c) => c.id)],
      true,
      'lane-curvature-revised',
      { fragment: { bendAmpTo, unit: 'px' }, status: 'recomputed', recomputed: r.inserted.length, skipped: r.skippedUnchanged.length }
    ),
    lanes.map((l) => l.id)
  );
}

/** 3. ladder 缺带：只改 ladder 标称来源。 */
export function scenarioLadderMissingBand(store: GelStore, missingMwBp = 4000): void {
  const ladder = store.objects('ladder', { currentOnly: true })[0].data as LadderObject;
  const removed = ladder.points.find((p) => p.mwBp === missingMwBp);
  if (!removed) throw new Error(`ladder 中不存在 ${missingMwBp} bp 标称点`);
  const next = rehash<LadderObject>({
    ...ladder,
    id: contentId('ladder', { prev: ladder.id, change: `missing-${missingMwBp}` }),
    points: ladder.points.filter((p) => p.mwBp !== missingMwBp)
  });
  store.supersedeObject(ladder.id, next);
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.ladder-band-missing',
    judgment(
      'ladder/missing-band',
      'ladder 缺带：相邻两段合并为更宽的局部标尺段，影响仅限覆盖该区间的条带',
      [ladder.id, removed.id],
      [next.id, ...r.inserted.map((c) => c.id)],
      true,
      'ladder-point-removed',
      {
        fragment: { removedMwBp: missingMwBp, unit: 'bp' },
        status: 'segment-widened',
        recomputed: r.inserted.length,
        skipped: r.skippedUnchanged.length
      }
    ),
    [ladder.id]
  );
}

/** 4. 饱和区：只改一个条带的饱和标记。 */
export function scenarioSaturatedRegion(store: GelStore, laneIndex = 1, mwBp = 3000): void {
  const lanes = store.objects('lane', { currentOnly: true }).map((o) => o.data as LaneObject);
  const lane = lanes.find((l) => l.index === laneIndex);
  if (!lane) throw new Error(`lane ${laneIndex} 不存在`);
  const bands = store.objects('band', { currentOnly: true }).map((o) => o.data as BandObject);
  const target = bands.find((b) => b.laneId === lane.id && !b.saturated);
  if (!target) throw new Error('未找到可饱和化的条带');
  const next = rehash<BandObject>({
    ...target,
    id: contentId('band', { prev: target.id, change: 'saturate' }),
    saturated: true,
    peakIntensity: 255,
    heightPx: target.heightPx + 6,
    source: { sourceEventId: target.source.sourceEventId, note: '饱和区修订：峰值截顶，中心不可信' }
  });
  store.supersedeObject(target.id, next);
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.region-saturated',
    judgment(
      'band/saturation-interval',
      '饱和条带、拖尾和重叠只能标为候选或区间',
      [target.id],
      [next.id, ...r.inserted.map((c) => c.id)],
      true,
      'saturation-to-interval',
      { fragment: { laneIndex, mwBp, peakIntensity: 255 }, status: 'interval-only', recomputed: r.inserted.length }
    ),
    [target.id]
  );
}

/** 5. 两条带重叠：只改重叠分组来源。 */
export function scenarioOverlapBands(store: GelStore, laneIndex = 3): void {
  const lanes = store.objects('lane', { currentOnly: true }).map((o) => o.data as LaneObject);
  const lane = lanes.find((l) => l.index === laneIndex);
  if (!lane) throw new Error(`lane ${laneIndex} 不存在`);
  const bands = store
    .objects('band', { currentOnly: true })
    .map((o) => o.data as BandObject)
    .filter((b) => b.laneId === lane.id)
    .sort((a, b) => a.center.y - b.center.y);
  // 找间距最小的一对，标记为重叠组
  let pair: [BandObject, BandObject] | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bands.length - 1; i++) {
    const d = bands[i + 1].center.y - bands[i].center.y;
    if (d < best) {
      best = d;
      pair = [bands[i], bands[i + 1]];
    }
  }
  if (!pair) throw new Error('泳道内条带不足，无法构造重叠');
  const groupId = contentId('og', { lane: lane.id, pair: [pair[0].id, pair[1].id] });
  const affected: string[] = [];
  for (const b of pair) {
    const next = rehash<BandObject>({
      ...b,
      id: contentId('band', { prev: b.id, change: 'overlap' }),
      overlapGroupId: groupId,
      source: { sourceEventId: b.source.sourceEventId, note: '两条带重叠：合并为重叠组，仅给候选' }
    });
    store.supersedeObject(b.id, next);
    affected.push(next.id);
  }
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.bands-overlapped',
    judgment(
      'band/overlap-candidates',
      '饱和条带、拖尾和重叠只能标为候选或区间；无法唯一决定时保留全部合法候选',
      pair.map((b) => b.id),
      [...affected, ...r.inserted.map((c) => c.id)],
      true,
      'overlap-to-candidates',
      { fragment: { laneIndex, gapPx: Math.round(best * 100) / 100, groupId }, status: 'candidates-only', recomputed: r.inserted.length }
    ),
    pair.map((b) => b.id)
  );
}

/** 6. 非单调标尺：只改 ladder 标称值顺序。 */
export function scenarioNonMonotonicLadder(store: GelStore): void {
  const ladder = store.objects('ladder', { currentOnly: true })[0].data as LadderObject;
  const sorted = ladder.points.slice().sort((a, b) => a.center.y - b.center.y);
  const i = sorted.findIndex((p) => p.mwBp === 2000);
  const j = sorted.findIndex((p) => p.mwBp === 1500);
  if (i < 0 || j < 0) throw new Error('缺少可交换的 ladder 点');
  const points = ladder.points.map((p) => {
    if (p.id === sorted[i].id) return { ...p, mwBp: 1500 };
    if (p.id === sorted[j].id) return { ...p, mwBp: 2000 };
    return p;
  });
  const next = rehash<LadderObject>({
    ...ladder,
    id: contentId('ladder', { prev: ladder.id, change: 'non-monotonic' }),
    points
  });
  store.supersedeObject(ladder.id, next);
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'scenario.ladder-non-monotonic',
    judgment(
      'ladder/non-monotonic',
      'ladder 标称值非单调：邻接标尺段失效，落在失效段的条带不得给出数值',
      [ladder.id, sorted[i].id, sorted[j].id],
      [next.id, ...r.inserted.map((c) => c.id)],
      true,
      'nominal-order-violated',
      {
        fragment: { swappedBp: [2000, 1500], unit: 'bp' },
        status: 'segments-invalidated',
        recomputed: r.inserted.length,
        invalid: r.inserted.filter((c) => c.result.kind === 'invalid').length
      }
    ),
    [ladder.id]
  );
}

/** 7. 修订后局部失效：人工修订一个 ladder 点位置，只有相邻段内的条带被取代。 */
export function scenarioRevisionLocalInvalidation(store: GelStore, targetMwBp = 7000, dyPx = 6): void {
  const ladder = store.objects('ladder', { currentOnly: true })[0].data as LadderObject;
  const point = ladder.points.find((p) => p.mwBp === targetMwBp);
  if (!point) throw new Error(`ladder 中不存在 ${targetMwBp} bp 标称点`);
  const points = ladder.points.map((p) =>
    p.id === point.id ? { ...p, center: { ...p.center, y: p.center.y + dyPx } } : p
  );
  const next = rehash<LadderObject>({
    ...ladder,
    id: contentId('ladder', { prev: ladder.id, change: `revise-${targetMwBp}` }),
    points
  });
  store.supersedeObject(ladder.id, next);
  const r = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'decision.adjust',
    judgment(
      'revision/local-invalidation',
      '人工修订 ladder 点位置：失效范围被限制在相邻标尺段覆盖的条带',
      [ladder.id, point.id],
      [next.id, ...r.inserted.map((c) => c.id)],
      true,
      'ladder-point-revised',
      {
        fragment: { targetMwBp, dyPx, unit: 'px' },
        status: 'local-invalidation',
        recomputed: r.inserted.length,
        skipped: r.skippedUnchanged.length
      }
    ),
    [ladder.id, point.id]
  );
}

export function runBoundaryScenarios(store: GelStore): void {
  scenarioRotateImage(store);
  scenarioCurveLanes(store);
  scenarioLadderMissingBand(store);
  scenarioSaturatedRegion(store);
  scenarioOverlapBands(store);
  scenarioRevisionLocalInvalidation(store);
  scenarioNonMonotonicLadder(store);
}
