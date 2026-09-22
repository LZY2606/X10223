import type { BandCenterMaterial, FrontCurveMaterial, ImageMaterial, LaneBoundaryMaterial, LadderMaterial } from '../shared/types.js';
import { synthesizeGel, scrambledLadder } from '../domain/gelSynth.js';
import { rotate180 } from '../domain/png.js';
import { sha256, eventId } from '../domain/util.js';
import { fitRuler, RULER_V2 } from '../domain/calibration.js';
import { committedSeq, type DB } from './db.js';
import { appendEvent, computeImageDerived, currentParams, insertMaterial, invalidateFrom, listMaterials, saveParams, applyDecision } from './store.js';

/**
 * 离线案例包：胶道标尺工作台。
 * 初始版本完整保留原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心的像素级来源。
 */
export function seedCasePack(db: DB): void {
  const gel = synthesizeGel('mat_image_A');

  appendEvent(db, {
    kind: 'import',
    summary: '导入原始凝胶图像 A（as-captured，曝光 0.8s/gain 2）及全部像素级来源材料',
    payload: {
      image: gel.image.id, orientation: gel.image.orientation, exposure: gel.image.exposure,
      ladder: gel.ladder.id, lanes: gel.lanes.length, bands: gel.bands.length,
    },
    parents: [],
  }, (seq) => {
    insertMaterial(db, gel.image, seq, gel.pixels);
    insertMaterial(db, gel.ladder, seq);
    for (const l of gel.lanes) insertMaterial(db, l, seq);
    insertMaterial(db, gel.frontCurve, seq);
    for (const b of gel.bands) insertMaterial(db, b, seq);
  });

  // 旋转 180° 的等价图像 B：同一物理凝胶的另一拍摄方向表示
  const pixelsB = rotate180(gel.image.width, gel.image.height, gel.pixels);
  const imageB: ImageMaterial = {
    kind: 'image', id: 'mat_image_B', width: gel.image.width, height: gel.image.height,
    orientation: 'rotated-180', exposure: gel.image.exposure, pixel_digest: sha256(pixelsB),
  };
  const rotP = (p: { x: number; y: number }) => ({ x: gel.image.width - 1 - p.x, y: gel.image.height - 1 - p.y });
  const provB = (p: { x: number; y: number }) => ({
    source: 'import' as const, pixel: rotP(p), image_id: 'mat_image_B', orientation: 'rotated-180' as const,
    original_pixel: { ...p }, note: '由图像 A 旋转 180° 得到，保留 as-captured 原像素',
  });
  const ladderB: LadderMaterial = {
    kind: 'ladder', id: 'mat_image_B_ladder', image_id: 'mat_image_B', lane_index: 0, label: gel.ladder.label,
    bands: gel.ladder.bands.map((b) => ({
      ...b, id: b.id.replace('mat_image_A', 'mat_image_B'),
      pixel: rotP(b.pixel), provenance: provB(b.pixel),
    })),
  };
  const frontB: FrontCurveMaterial = {
    kind: 'front-curve', id: 'mat_image_B_front', image_id: 'mat_image_B', reference_lane: 0,
    points: gel.frontCurve.points.map((p) => ({ point: rotP(p.point), provenance: provB(p.point) })),
  };
  const bandsB: BandCenterMaterial[] = gel.bands.map((b) => ({
    ...b, id: b.id.replace('mat_image_A', 'mat_image_B'), image_id: 'mat_image_B',
    pixel: rotP(b.pixel), provenance: provB(b.pixel),
  }));
  const lanesB: LaneBoundaryMaterial[] = gel.lanes.map((l) => ({
    ...l, id: l.id.replace('mat_image_A', 'mat_image_B'), image_id: 'mat_image_B',
    centerline: l.centerline.map((c) => ({ point: rotP(c.point), provenance: provB(c.point) })),
  }));

  appendEvent(db, {
    kind: 'import',
    summary: '导入旋转 180° 的等价图像 B（保留 as-captured 原像素来源）',
    payload: { image: imageB.id, orientation: imageB.orientation },
    parents: [gel.image.id],
  }, (seq) => {
    insertMaterial(db, imageB, seq, pixelsB);
    insertMaterial(db, ladderB, seq);
    insertMaterial(db, frontB, seq);
    for (const l of lanesB) insertMaterial(db, l, seq);
    for (const b of bandsB) insertMaterial(db, b, seq);
  });

  // 非单调标尺反例材料（不参与自动计算，供边界检验触发）
  const nonmono = scrambledLadder(gel.ladder, 'mat_image_A_ladder_nonmono');
  appendEvent(db, {
    kind: 'import',
    summary: '登记非单调标尺反例材料（ladder 标称值被打乱，用于检验 semantic_unsolvable）',
    payload: { ladder: nonmono.id },
    parents: [gel.ladder.id],
  }, (seq) => insertMaterial(db, nonmono, seq));

  appendEvent(db, {
    kind: 'review-confirm',
    summary: '审阅者核对基线：原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心的像素级来源一致',
    payload: { confirmed: [gel.image.id, gel.ladder.id, gel.frontCurve.id, ...gel.lanes.map((l) => l.id), ...gel.bands.map((b) => b.id)] },
    parents: [gel.image.id],
  });

  appendEvent(db, {
    kind: 'recompute',
    summary: `初始计算：局部标尺 ${currentParams(db).ruler.version}，微笑曲线校正，分子量推断`,
    payload: { images: ['mat_image_A', 'mat_image_B'] },
    parents: [gel.ladder.id, gel.frontCurve.id],
  }, (seq) => {
    computeImageDerived(db, 'mat_image_A', seq, currentParams(db));
    computeImageDerived(db, 'mat_image_B', seq, currentParams(db));
  });
}

/** 案例叙事分支：参数修订 → 局部源改动（局部失效）→ 冲突决定。 */
export function runNarrative(db: DB): { events: string[]; invalidated: string[] } {
  const out: string[] = [];
  let invalidated: string[] = [];

  // 1. 参数修订：重叠阈值 10→14px，版本升到 ruler-v2，全量重算
  const params = currentParams(db);
  params.ruler = { ...RULER_V2 };
  saveParams(db, params);
  const e1 = appendEvent(db, {
    kind: 'param-revision',
    summary: '参数修订：重叠判定阈值 10→14px（ruler-v1 → ruler-v2），全量重算',
    payload: { from: 'ruler-v1', to: 'ruler-v2', overlap_px: 14 },
    parents: [],
  }, (seq) => {
    computeImageDerived(db, 'mat_image_A', seq, currentParams(db));
    computeImageDerived(db, 'mat_image_B', seq, currentParams(db));
  });
  out.push(e1.id);

  // 2. 局部源数据改动：人工修订 lane 3 一个条带中心，只允许局部失效
  const target = listMaterials(db).find((m): m is BandCenterMaterial =>
    m.kind === 'band-center' && m.image_id === 'mat_image_A' && m.lane_index === 3)!;
  const revised: BandCenterMaterial = {
    ...target,
    id: `${target.id}_rev1`,
    pixel: { x: target.pixel.x, y: target.pixel.y + 6 },
    provenance: { ...target.provenance, source: 'manual', original_pixel: { ...target.pixel }, note: '人工修订：条带中心下移 6px' },
  };
  const e2id = eventId(committedSeq(db) + 1);
  const e2 = appendEvent(db, {
    kind: 'source-change',
    summary: `局部源改动：人工修订 ${target.id} 的条带中心（+6px），检验失效是否被限制在正确范围`,
    payload: { replaced: target.id, revised: revised.id, delta_px: 6 },
    parents: [target.id],
  }, (seq) => {
    insertMaterial(db, revised, seq);
    invalidated = invalidateFrom(db, [target.id, revised.id], seq, e2id, currentParams(db));
  });
  out.push(e2.id);

  // 3. 互相冲突的人工决定：同一估计被一位审阅者接受、另一位否定，两者都保留
  const estSubject = `est:${target.id}`;
  const e3 = appendEvent(db, {
    kind: 'decision',
    summary: `审阅者 A 接受 ${estSubject} 的修订后估计`,
    payload: { subject_id: estSubject, decision: 'accepted', reviewer: 'reviewer-A' },
    parents: [estSubject],
  }, (seq) => applyDecision(db, estSubject, 'accepted', seq));
  const e4 = appendEvent(db, {
    kind: 'decision',
    summary: `审阅者 B 否定 ${estSubject}（与审阅者 A 冲突）`,
    payload: { subject_id: estSubject, decision: 'rejected', reviewer: 'reviewer-B' },
    parents: [estSubject, e3.id],
  }, (seq) => applyDecision(db, estSubject, 'rejected', seq));
  const e5 = appendEvent(db, {
    kind: 'conflict',
    summary: `冲突记录：${estSubject} 同时存在接受与否定，标记为 contested，两个决定都保留`,
    payload: { subject_id: estSubject, kept: [e3.id, e4.id], resolution: 'contested' },
    parents: [e3.id, e4.id],
  }, (seq) => applyDecision(db, estSubject, 'contested', seq));
  out.push(e3.id, e4.id, e5.id);

  return { events: out, invalidated };
}

/** 边界组合检验：非单调标尺触发 semantic_unsolvable，并记录为机器可读事件。 */
export function runBoundaryChecks(db: DB): Record<string, unknown> {
  const materials = listMaterials(db);
  const nonmono = materials.find((m): m is LadderMaterial => m.kind === 'ladder' && m.id.includes('nonmono'))!;
  const frontA = materials.find((m): m is FrontCurveMaterial => m.kind === 'front-curve' && m.image_id === 'mat_image_A')!;
  const fit = fitRuler(nonmono, frontA, currentParams(db).ruler);
  const evt = appendEvent(db, {
    kind: 'narrative',
    summary: `边界检验：非单调标尺 → ${fit.status}（资源耗尽/格式损坏/语义无解三者可区分）`,
    payload: { nonmono_fit: fit },
    parents: [nonmono.id],
  });
  return { event: evt.id, nonmono_fit: fit };
}
