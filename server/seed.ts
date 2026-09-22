/**
 * 基线播种：导入案例包 -> 材料核对事件 -> 基线计算 ->
 * 一次参数修订、一次局部源数据改动、一次互相冲突的人工决定。
 */
import { MW_PARAMS_V1, MW_PARAMS_V2 } from '../shared/infer.js';
import type { JudgmentPayload, LaneObject, LadderObject } from '../shared/types.js';
import { BASE_SPEC, generateGel, imageObjectOf } from './casepack.js';
import type { GelStore } from './db.js';
import { recomputeMW } from './recompute.js';

export function judgment(
  ruleId: string,
  statement: string,
  inputs: string[],
  affected: string[],
  adopted: boolean,
  rationaleCode: string,
  detail?: Record<string, unknown>
): JudgmentPayload {
  return { ruleId, statement, inputs, affected, adopted, rationaleCode, detail };
}

export function seedBaseline(store: GelStore): void {
  const spec = BASE_SPEC;
  const importEvt = store.appendEvent('material.image-imported', {
    fragment: { width: spec.width, height: spec.height, orientationDeg: 0, exposureMs: spec.exposureMs },
    status: 'accepted',
    note: '原始凝胶图像导入，保留原始像素表示'
  });
  const gel = generateGel(spec, importEvt.id);
  const image = imageObjectOf(gel, spec, 0);
  store.putObject(image);

  const laneEvt = store.appendEvent(
    'material.lanes-defined',
    judgment(
      'provenance/pixel-source',
      'lane 边界与中心线均保留像素级来源',
      [image.id],
      gel.lanes.map((l) => l.id),
      true,
      'lanes-from-pixel-profile',
      { smileAmp: spec.smileAmp, bendAmp: spec.bendAmp, unit: 'px', basis: 'image-raw' }
    ),
    [image.id]
  );
  for (const lane of gel.lanes) store.putObject(lane);

  const ladderEvt = store.appendEvent(
    'material.ladder-imported',
    judgment(
      'provenance/nominal-values',
      'ladder 标称值按原始表示导入，派生层才做换算',
      [image.id],
      [gel.ladder.id],
      true,
      'ladder-nominal-bp',
      { nominalBp: spec.ladderMwBp, unit: 'bp' }
    ),
    [image.id]
  );
  store.putObject(gel.ladder);

  const bandEvt = store.appendEvent(
    'material.bands-detected',
    judgment(
      'detect/auto-candidates',
      '自动条带候选全部保留像素级中心与轮廓来源',
      gel.lanes.map((l) => l.id),
      gel.bands.map((b) => b.id),
      true,
      'auto-detect-v1',
      { count: gel.bands.length, unit: 'px' }
    ),
    gel.lanes.map((l) => l.id)
  );
  for (const band of gel.bands) store.putObject(band);

  // 基线计算（参数 v1）
  const r1 = recomputeMW(store, MW_PARAMS_V1);
  store.appendEvent(
    'compute.baseline',
    judgment(
      'compute/mw-baseline',
      '基线分子量推断：局部 log 线性标尺，饱和给区间、重叠给候选',
      [gel.ladder.id, ...gel.lanes.map((l) => l.id)],
      r1.inserted.map((c) => c.id),
      true,
      'params-mw-interp-v1',
      { paramVersion: MW_PARAMS_V1.version, inserted: r1.inserted.length }
    ),
    [ladderEvt.id, bandEvt.id]
  );

  // 一次参数修订：v1 -> v2（越界策略由拒绝改为钳制区间）
  const r2 = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'compute.param-revised',
    judgment(
      'compute/param-revision',
      '参数修订 mw-interp/v1 -> mw-interp/v2：越界条带由失效改为边界钳制区间',
      [gel.ladder.id],
      r2.inserted.map((c) => c.id),
      true,
      'params-mw-interp-v2',
      { from: MW_PARAMS_V1.version, to: MW_PARAMS_V2.version, inserted: r2.inserted.length, skipped: r2.skippedUnchanged.length }
    ),
    []
  );

  // 一次只影响局部依赖的源数据改动：平移 lane 2 的横向弯曲
  const curvedSpec = { ...spec, bendAmp: 14 };
  const gel2 = generateGel(curvedSpec, importEvt.id);
  const lane2Old = gel.lanes[2];
  const lane2New = gel2.lanes[2];
  store.supersedeObject(lane2Old.id, lane2New);
  const r3 = recomputeMW(store, MW_PARAMS_V2);
  store.appendEvent(
    'material.lane-curved',
    judgment(
      'geometry/smile-local-scale',
      '“微笑”弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域',
      [lane2Old.id],
      [lane2New.id, ...r3.inserted.map((c) => c.id)],
      true,
      'lane-bend-revised',
      { laneIndex: 2, bendAmpFrom: spec.bendAmp, bendAmpTo: 14, recomputed: r3.inserted.length, skipped: r3.skippedUnchanged.length }
    ),
    [laneEvt.id]
  );

  // 一次互相冲突的人工决定：对同一条带的自动候选，两名审阅者结论相反
  const targetBand = gel.bands.find((b) => !b.saturated && !b.overlapGroupId);
  if (targetBand) {
    const comp = store.visibleComputationsAt(store.currentSeq()).find((c) => c.bandId === targetBand.id);
    if (comp) {
      store.appendEvent(
        'decision.accept',
        judgment('review/manual-accept', '审阅者 A 接受自动候选分子量', [comp.id], [comp.id], true, 'reviewer-a-accept'),
        [comp.id],
        'review-a'
      );
      store.appendEvent(
        'decision.reject',
        judgment('review/manual-reject', '审阅者 B 否定同一候选，认为条带归属存疑', [comp.id], [comp.id], false, 'reviewer-b-reject'),
        [comp.id],
        'review-b'
      );
      store.appendEvent(
        'decision.conflict-logged',
        judgment(
          'review/conflict',
          '同一计算收到互相冲突的人工决定，两条分支均保留，等待仲裁',
          [comp.id],
          [comp.id],
          false,
          'conflict-open',
          { branches: ['review-a', 'review-b'] }
        ),
        [comp.id]
      );
    }
  }
}
