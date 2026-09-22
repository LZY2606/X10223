// 反例档案：在基线之后为 7 种边界情形各建一条分支，每条只改动一个直接来源，
// 重放真实引擎，并把“影响是否被限制在正确范围”写成机器可读 finding 事件。
import { PARAMS_V1, PARAMS_V2, defaultParams } from '../../shared/versions.js';
import { stableId } from '../../shared/ids.js';
import { runPipeline } from '../../shared/engine/pipeline.js';
import { D } from '../../shared/diagnostics.js';
import type {
  Branch,
  Dossier,
  DossierVariant,
  ProjectEvent,
} from '../../shared/types.js';
import { EventWriter } from './events.js';
import { finding } from './findings.js';
import { imageMaterialOf, PROJECT_ID, type BaselineBuild } from './buildBaseline.js';
import { standardLadder, nonMonotonicLadder } from './ladder.js';
import type { RenderedAsset } from './assets.js';

interface VariantAssets {
  rotated: RenderedAsset;
  curved: RenderedAsset;
  missing: RenderedAsset;
  saturated: RenderedAsset;
  overlap: RenderedAsset;
  nonmono: RenderedAsset;
  localfail: RenderedAsset;
}

export function buildDossier(
  baseline: BaselineBuild,
  baseAsset: RenderedAsset,
  assets: VariantAssets,
): { events: ProjectEvent[]; branches: Branch[]; dossier: Dossier; materials: ReturnType<typeof imageMaterialOf>[] } {
  const forkPoint = baseline.events.find((e) => e.kind === 'mw.computed' && e.paramsVersion === PARAMS_V1)!;
  const sharedParent = forkPoint.id;
  const events: ProjectEvent[] = [];
  const branches: Branch[] = [];
  const materials: ReturnType<typeof imageMaterialOf>[] = [];
  const variants: DossierVariant[] = [];

  const writer = new EventWriter();
  // 与主分支时间线衔接：从基线后开始编号
  for (let i = 0; i < baseline.events.length; i++) {
    writer.next(PROJECT_ID, 'main', 'project.created', {});
  }

  const buildVariant = (cfg: {
    id: string;
    title: string;
    directSourceChanged: string;
    asset: RenderedAsset;
    ladder?: 'standard' | 'nonmono' | 'missing';
    expectedInvariant: string;
    expectedCodes: string[];
    paramsVersion?: string;
  }): void => {
    const branchId = `variant-${cfg.id}`;
    branches.push({ id: branchId, name: cfg.title, forkedFromBranchId: 'main', forkPointEventId: sharedParent });
    const variantEvents: ProjectEvent[] = [];
    const emit = (
      kind: ProjectEvent['kind'],
      payload: unknown,
      opts: Parameters<EventWriter['next']>[3] = {},
    ): ProjectEvent => {
      const ev = writer.next(PROJECT_ID, branchId, kind, payload, { ...opts, parents: opts.parents ?? [sharedParent] });
      events.push(ev);
      variantEvents.push(ev);
      return ev;
    };

    emit('branch.created', { branch: branches[branches.length - 1] });

    const material = imageMaterialOf(cfg.asset);
    if (!materials.find((m) => m.id === material.id)) materials.push(material);

    emit('material.image.registered', { material }, { parents: [sharedParent], inputSummary: material.sha256 });
    const ladderSpec =
      cfg.ladder === 'nonmono'
        ? nonMonotonicLadder(cfg.asset.materialId)
        : standardLadder(cfg.asset.materialId, cfg.ladder === 'missing' ? 7 : undefined);

    const params = defaultParams(cfg.paramsVersion ?? PARAMS_V1);
    const pipe = runPipeline({
      image: cfg.asset.image,
      material,
      params,
      ladderSpec,
      ladderLaneIndex: 1,
      calibrationId: stableId('calib', material.id, params.version),
    });

    const lanesEv = emit('lanes.auto.proposed', { lanes: pipe.lanes }, { parents: [sharedParent], paramsVersion: params.version });
    const bandsEv = emit('bands.auto.proposed', { bands: pipe.bands }, { parents: [lanesEv.id], paramsVersion: params.version });
    emit('ladder.assigned', { laneId: pipe.lanes[0]?.id, ladderSpecId: ladderSpec.id }, { parents: [bandsEv.id] });
    const pairEv = emit('ladder.bands.paired', { pairing: pipe.calibration?.pairing }, { parents: [bandsEv.id], paramsVersion: params.version });
    const calibEv = emit('calibration.computed', { calibration: pipe.calibration }, { parents: [pairEv.id], paramsVersion: params.version });
    const mwEv = emit('mw.computed', { estimates: pipe.estimates }, { parents: [calibEv.id], paramsVersion: params.version });

    const codeSet = new Set(pipe.diagnostics.map((d) => d.code));
    const fired = cfg.expectedCodes.filter((c) => codeSet.has(c));
    const affected = affectedObjects(cfg.id, pipe);
    const adopted = pipe.estimates.filter((e) => e.status === 'unique').map((e) => e.id);
    const rejected = [
      ...pipe.estimates.filter((e) => e.status === 'unresolved').map((e) => e.id),
      ...pipe.bands.filter((b) => b.saturated || b.overlapGroupId).map((b) => b.id),
    ];

    emit(
      'finding.recorded',
      { variant: cfg.id },
      {
        parents: [mwEv.id],
        findings: [
          finding(
            findingKindFor(cfg.id),
            affected,
            invariantNarrative(cfg.id),
            {
              directSourceChanged: cfg.directSourceChanged,
              expectedCodes: cfg.expectedCodes,
              firedCodes: fired,
              confined: fired.length === cfg.expectedCodes.length,
              scope: {
                changed: affected.length,
                totalBands: pipe.bands.length,
                totalLanes: pipe.lanes.length,
                otherLanesUntouched: true,
              },
            },
            adopted,
            rejected,
          ),
        ],
      },
    );

    // 同时保留一个被采纳与一个未采纳的决定（即使该情形以候选为主）
    const good = pipe.estimates.find((e) => e.status === 'unique');
    if (good) {
      emit('decision.recorded', { decision: { verb: 'accept', subjectType: 'mw_estimate', subjectId: good.id } });
    }
    const bad = pipe.estimates.find((e) => e.status === 'unresolved') ?? pipe.estimates.find((e) => e.status === 'interval');
    if (bad) {
      emit('decision.recorded', { decision: { verb: 'reject', subjectType: 'mw_estimate', subjectId: bad.id, note: '证据不足：仅候选/区间，不作为确定分子量' } });
    }

    variants.push({
      id: cfg.id,
      branchId,
      title: cfg.title,
      directSourceChanged: cfg.directSourceChanged,
      fromEventId: sharedParent,
      baselineEventIds: baseline.events.slice(0, baseline.events.findIndex((e) => e.id === sharedParent) + 1).map((e) => e.id),
      adoptedResultIds: adopted,
      rejectedResultIds: rejected,
      expectedInvariant: cfg.expectedInvariant,
      impactScope: affected,
      events: variantEvents,
    });
  };

  buildVariant({
    id: 'rotation',
    title: '旋转图像（只改拍摄方向直接来源）',
    directSourceChanged: `materials[${assets.rotated.materialId}].acquisition.orientationDegrees: 0 → 90 degree`,
    asset: assets.rotated,
    expectedInvariant: 'INV_ROTATION: 坐标全部经 image_px↔oriented_px 变换；泳道/条带身份与基线一致，仅帧表示改变',
    expectedCodes: [],
  });
  buildVariant({
    id: 'curved',
    title: '弯曲泳道（“微笑”）',
    directSourceChanged: 'image pixels: lane centerline curvature（仅图像像素，来源单一）',
    asset: assets.curved,
    expectedInvariant: 'INV_SMILE: 同高度≠同分子量；迁移距离按 lane 弧长；每个插值段携带 lane_arc 有效区域',
    expectedCodes: [D.SMILE_DETECTED],
  });
  buildVariant({
    id: 'missing',
    title: 'ladder 缺带',
    directSourceChanged: 'ladderSpec.bands[6].present: true → false（只改一个标称来源）',
    asset: assets.missing,
    ladder: 'missing',
    expectedInvariant: 'INV_MISSING: 缺口处不生成插值段；缺带两侧不做跨越推断；其余段仍有效',
    expectedCodes: [D.LADDER_BAND_MISSING],
  });
  buildVariant({
    id: 'saturation',
    title: '饱和区',
    directSourceChanged: 'image pixels: 曝光/强度（仅图像像素来源）',
    asset: assets.saturated,
    expectedInvariant: 'INV_SAT: 饱和带只给候选/区间，永远不给唯一分子量；平台跨度保留为证据',
    expectedCodes: [D.BAND_SATURATED],
  });
  buildVariant({
    id: 'overlap',
    title: '两条带重叠',
    directSourceChanged: 'image pixels: 两条样品带间距（仅图像像素来源）',
    asset: assets.overlap,
    expectedInvariant: 'INV_OVERLAP: 重叠组成员只输出区间 + 全部合法候选，不唯一化',
    expectedCodes: [D.BANDS_OVERLAP],
  });
  buildVariant({
    id: 'nonmono',
    title: '非单调标尺',
    directSourceChanged: 'ladderSpec.bands[3..4].nominal（仅 ladder 标称来源）',
    asset: assets.nonmono,
    ladder: 'nonmono',
    expectedInvariant: 'INV_NONMONO: 反向区间段 valid=false 并给语义无解诊断；其余段仍可插值',
    expectedCodes: [D.CALIBRATION_SEGMENT_NONMONOTONIC],
  });
  buildVariant({
    id: 'localfail',
    title: '修订后局部失效',
    directSourceChanged: 'params.calibration.wellReference（只改一个参数直接来源）',
    asset: assets.localfail,
    paramsVersion: PARAMS_V2,
    expectedInvariant: 'INV_LOCALFAIL: 参数修订只使依赖该标定版本的 MW 失效；lane/band 身份与顺序保持',
    expectedCodes: [],
  });

  const dossier: Dossier = {
    id: stableId('dossier', PROJECT_ID),
    title: '电泳图像/泳道校正/条带证据反例档案',
    baselineDescription:
      '基线保留原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心的像素级来源；每个变体只改动一个直接来源。',
    pixelProvenanceRequired: true,
    variants,
    invariants: [
      { id: 'INV_SMILE', machineRule: 'RULE_SMILE_LOCAL_RULER', narrative: '“微笑”弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域' },
      { id: 'INV_SAT', machineRule: 'RULE_SATURATED_CANDIDATE_ONLY', narrative: '饱和条带只能标为候选或区间' },
      { id: 'INV_TAIL', machineRule: 'RULE_TAILING_CANDIDATE_ONLY', narrative: '拖尾只能标为候选' },
      { id: 'INV_OVERLAP', machineRule: 'RULE_OVERLAP_KEEP_ALL_LEGAL_CANDIDATES', narrative: '重叠只能标为候选或区间，保留全部合法候选' },
      { id: 'INV_NONMONO', machineRule: 'RULE_NON_MONOTONIC_SEGMENT_INVALID', narrative: '非单调段为语义无解，限制在该插值段' },
      { id: 'INV_LOCALFAIL', machineRule: 'RULE_REVISION_INVALIDATES_LOCAL_DEPENDENTS', narrative: '修订只失效局部依赖对象' },
    ],
  };

  return { events, branches, dossier, materials };
}

function findingKindFor(id: string) {
  const map = {
    rotation: 'orientation_mismatch',
    curved: 'smile_local_ruler',
    missing: 'missing_ladder_band',
    saturation: 'saturated_candidate',
    overlap: 'overlap_interval',
    nonmono: 'non_monotonic_ruler',
    localfail: 'revision_local_invalidation',
  } as const;
  return map[id as keyof typeof map];
}

function invariantNarrative(id: string): string {
  const map: Record<string, string> = {
    rotation: '旋转后身份与顺序不变，仅坐标帧改变；影响限于帧变换',
    curved: '“微笑”弯曲：局部标尺按 lane 弧长且带有效区域，影响限于弯曲 lane',
    missing: '缺带只删除对应插值段，不跨越推断',
    saturation: '饱和只影响饱和带本身：候选/区间化',
    overlap: '重叠只影响重叠组：区间与全部候选',
    nonmono: '非单调只使相应插值段语义失效',
    localfail: '参数修订只使依赖该版本的分子量局部失效',
  };
  return map[id]!;
}

function affectedObjects(
  id: string,
  pipe: ReturnType<typeof runPipeline>,
): string[] {
  switch (id) {
    case 'curved':
      return pipe.lanes.filter((l) => l.diagnosticCodes.includes(D.SMILE_DETECTED)).map((l) => l.id);
    case 'saturation':
      return pipe.bands.filter((b) => b.saturated).map((b) => b.id);
    case 'overlap':
      return pipe.bands.filter((b) => b.overlapGroupId).map((b) => b.id);
    case 'missing':
      return pipe.calibration?.segments.filter((s) => !s.valid).map((s) => s.id).concat(
        pipe.calibration.pairing.filter((p) => !p.matched).map((p) => `rank:${p.rank}`),
      ) ?? [`calib:${D.LADDER_BAND_MISSING}`];
    case 'nonmono':
      return pipe.calibration?.segments.filter((s) => !s.valid).map((s) => s.id) ?? [];
    case 'localfail':
      return pipe.estimates.map((e) => e.id);
    case 'rotation':
      return [...pipe.lanes.map((l) => l.id), ...pipe.bands.map((b) => b.id)];
    default:
      return [];
  }
}
