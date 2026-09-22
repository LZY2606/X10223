// 主分支完整叙事：导入→核对来源→自动候选→ladder→标定→分子量→参数修订
// →局部源数据改动→互相冲突的人工决定。所有自动结果都由引擎真实重算。
import { PARAMS_V1, PARAMS_V2, defaultParams } from '../../shared/versions.js';
import { runPipeline } from '../../shared/engine/pipeline.js';
import { nearestS } from '../../shared/geometry.js';
import { stableId } from '../../shared/ids.js';
import type {
  Band,
  FindingPayload,
  ImageMaterial,
  LadderSpec,
  Lane,
  MolecularWeightEstimate,
  ProjectEvent,
} from '../../shared/types.js';
import { D } from '../../shared/diagnostics.js';
import type { RenderedAsset } from './assets.js';
import { EventWriter } from './events.js';
import { finding } from './findings.js';
import { standardLadder } from './ladder.js';

export const PROJECT_ID = 'proj_gel_case_0001';
export const PROJECT_NAME = '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台';

export interface BaselineBuild {
  events: ProjectEvent[];
  imageMaterial: ImageMaterial;
  ladderSpec: LadderSpec;
  lanes: Lane[];
  bands: Band[];
  estimates: MolecularWeightEstimate[];
  profiles: ReturnType<typeof runPipeline>['profiles'];
  calibrationId: string;
  writer: EventWriter;
  acceptedBandId: string;
  rejectedBandId: string;
  revisedBandId: string;
  acceptedMwId: string;
}

export function imageMaterialOf(asset: RenderedAsset): ImageMaterial {
  return {
    kind: 'image',
    id: asset.materialId,
    filename: asset.filename,
    byteLength: asset.bytes.length,
    sha256: asset.sha256,
    mediaType: 'image/png',
    widthPx: asset.image.width,
    heightPx: asset.image.height,
    acquisition: {
      orientationDegrees: asset.orientationDegrees,
      exposure: { durationS: asset.exposureDurationS, gainIso: 200 },
    },
  };
}

export function buildBaseline(asset: RenderedAsset): BaselineBuild {
  const writer = new EventWriter();
  const imageMaterial = imageMaterialOf(asset);
  const ladderSpec = standardLadder(asset.materialId);
  const calibrationId = stableId('calib', imageMaterial.id, PARAMS_V1);

  const pipe = runPipeline({
    image: asset.image,
    material: imageMaterial,
    params: defaultParams(PARAMS_V1),
    ladderSpec,
    ladderLaneIndex: 1,
    calibrationId,
  });
  const { lanes, bands, estimates } = pipe;

  const events: ProjectEvent[] = [];
  const emit = (
    kind: ProjectEvent['kind'],
    payload: unknown,
    opts: Parameters<EventWriter['next']>[3] = {},
  ): ProjectEvent => {
    const ev = writer.next(PROJECT_ID, 'main', kind, payload, opts);
    events.push(ev);
    return ev;
  };

  const created = emit('project.created', {
    projectId: PROJECT_ID,
    name: PROJECT_NAME,
    narrative: '分子实验室凝胶审阅：自动候选 vs 人工修订的分子量推断',
  });

  const imgEv = emit(
    'material.image.registered',
    { material: imageMaterial },
    {
      parents: [created.id],
      inputSummary: imageMaterial.sha256,
      findings: [
        finding(
          'orientation_mismatch',
          [imageMaterial.id],
          `基线来源核对：拍摄方向 ${imageMaterial.acquisition.orientationDegrees}°（degree）、曝光 ${imageMaterial.acquisition.exposure.durationS}s（second）、像素尺寸 ${imageMaterial.widthPx}x${imageMaterial.heightPx}（pixel, image_px）均保留原始表示`,
          {
            orientationDegrees: imageMaterial.acquisition.orientationDegrees,
            exposureDurationS: imageMaterial.acquisition.exposure.durationS,
            frame: 'image_px',
          },
        ),
      ],
    },
  );

  emit(
    'material.ladder.registered',
    { material: { ...ladderSpec, kind: 'ladder_spec' } },
    { parents: [created.id], inputSummary: ladderSpec.id },
  );

  const lanesEv = emit(
    'lanes.auto.proposed',
    { lanes },
    {
      parents: [imgEv.id],
      paramsVersion: PARAMS_V1,
      inputSummary: pipe.derivations.find((d) => d.kind === 'lanes.detected')?.inputSummary,
      findings: pipe.diagnostics.some((d) => d.code === D.SMILE_DETECTED)
        ? [
            finding(
              'smile_local_ruler',
              lanes.map((l) => l.id),
              '泳道弯曲：同一像素高度不等于同一分子量，局部标尺必须带有效区域',
              { rule: 'per-lane arc length + segment valid region' },
            ),
          ]
        : undefined,
    },
  );

  const bandsEv = emit(
    'bands.auto.proposed',
    { bands },
    {
      parents: [lanesEv.id],
      paramsVersion: PARAMS_V1,
      inputSummary: pipe.derivations.find((d) => d.kind === 'bands.detected')?.inputSummary,
      findings: bandFindings(bands),
    },
  );

  const ladderLane = lanes[0]!;
  emit(
    'ladder.assigned',
    { laneId: ladderLane.id, ladderSpecId: ladderSpec.id },
    { parents: [bandsEv.id] },
  );

  const pairingEv = emit(
    'ladder.bands.paired',
    { pairing: pipe.calibration?.pairing },
    {
      parents: [bandsEv.id],
      paramsVersion: PARAMS_V1,
      findings: missingFindings(pipe.calibration),
    },
  );

  const calibEv = emit(
    'calibration.computed',
    { calibration: pipe.calibration },
    {
      parents: [pairingEv.id],
      paramsVersion: PARAMS_V1,
      inputSummary: pipe.derivations.find((d) => d.kind === 'calibration.fitted')?.inputSummary,
    },
  );

  const mwEv = emit(
    'mw.computed',
    { estimates },
    {
      parents: [calibEv.id],
      paramsVersion: PARAMS_V1,
      inputSummary: pipe.derivations.find((d) => d.kind === 'mw.estimated')?.inputSummary,
    },
  );

  // 接受一个高可信结果
  const firstUnique = estimates.find((e) => e.status === 'unique' && e.primary)!;
  emit(
    'decision.recorded',
    {
      decision: { verb: 'accept', subjectType: 'mw_estimate', subjectId: firstUnique.id, note: '审阅人接受自动分子量' },
    },
    {
      parents: [mwEv.id],
      findings: [
        finding('adopted_result', [firstUnique.id], `采纳自动分子量 ${firstUnique.primary!.value} bp`, { value: firstUnique.primary!.value, unit: 'bp' }, [firstUnique.id]),
      ],
    },
  );

  // 否定另一条带
  const rejectTarget = bands.find((b) => !b.saturated && !b.overlapGroupId && b.laneId !== ladderLane.id) ?? bands[bands.length - 1]!;
  emit(
    'decision.recorded',
    { decision: { verb: 'reject', subjectType: 'band', subjectId: rejectTarget.id, note: '判定为噪声/边缘伪影' } },
    {
      parents: [mwEv.id],
      findings: [finding('rejected_result', [rejectTarget.id], '人工否定该候选带', {}, [], [rejectTarget.id])],
    },
  );

  // 参数修订 v1→v2（加样口参考改为沿 lane 弧长）
  const calibV2Id = stableId('calib', imageMaterial.id, PARAMS_V2);
  const pipeV2 = runPipeline({
    image: asset.image,
    material: imageMaterial,
    params: defaultParams(PARAMS_V2),
    ladderSpec,
    ladderLaneIndex: 1,
    calibrationId: calibV2Id,
  });
  const paramsEv = emit(
    'params.revised',
    {
      from: PARAMS_V1,
      params: defaultParams(PARAMS_V2),
      reason: '微笑校正：wellReference image_top → lane_arc_origin',
    },
    { parents: [mwEv.id], paramsVersion: PARAMS_V2 },
  );
  emit('lanes.auto.proposed', { lanes: pipeV2.lanes }, { parents: [paramsEv.id], paramsVersion: PARAMS_V2 });
  emit('bands.auto.proposed', { bands: pipeV2.bands }, { parents: [paramsEv.id], paramsVersion: PARAMS_V2 });
  emit('calibration.computed', { calibration: pipeV2.calibration }, { parents: [paramsEv.id], paramsVersion: PARAMS_V2 });
  emit('mw.computed', { estimates: pipeV2.estimates }, { parents: [paramsEv.id], paramsVersion: PARAMS_V2 });

  // 局部源数据改动：人工修订一条带中心（只改该像素来源），只影响局部依赖
  const reviseTarget = pipeV2.bands.find((b) => b.laneId !== ladderLane.id && !b.overlapGroupId) ?? pipeV2.bands[pipeV2.bands.length - 1]!;
  const revised = reviseBandCenter(reviseTarget, lanes.find((l) => l.id === reviseTarget.laneId)!, imgEv.id, 4);
  const reviseEv = emit(
    'bands.centers.revised',
    { band: revised },
    {
      parents: [paramsEv.id],
      findings: [
        finding(
          'revision_local_invalidation',
          [reviseTarget.id],
          '条带中心像素来源被人工修订：仅该带及其分子量推断失效重算，其它对象不受影响',
          { parentId: reviseTarget.id, deltaSpx: revised.migrationS.value - reviseTarget.migrationS.value },
          [revised.id],
          [reviseTarget.id],
        ),
      ],
    },
  );
  const affectedEst = pipeV2.estimates.find((e) => e.bandId === reviseTarget.id);
  if (affectedEst) {
    emit(
      'decision.recorded',
      { decision: { verb: 'adjust', subjectType: 'mw_estimate', subjectId: affectedEst.id, paramsDiff: { bandCenterY: revised.center.y }, note: '因中心修订触发局部重算' } },
      { parents: [reviseEv.id], paramsVersion: PARAMS_V2 },
    );
  }

  // 互相冲突的人工决定：对同一候选先接受再否定（同分支保留两次决定事件）
  const conflictBand = pipeV2.bands.find((b) => b.laneId !== ladderLane.id && b.id !== reviseTarget.id && !b.overlapGroupId) ?? pipeV2.bands[0]!;
  const conflictMw = pipeV2.estimates.find((e) => e.bandId === conflictBand.id);
  const acceptConflict = emit(
    'decision.recorded',
    { decision: { verb: 'accept', subjectType: 'band', subjectId: conflictBand.id, note: '审阅人 A 接受' } },
    { parents: [reviseEv.id] },
  );
  emit(
    'decision.recorded',
    {
      decision: {
        verb: 'reject',
        subjectType: 'band',
        subjectId: conflictBand.id,
        supersedesEventId: acceptConflict.id,
        note: '审阅人 B 否定（冲突决定并存，最新投影标记 rejected，历史不被覆盖）',
      },
    },
    {
      parents: [acceptConflict.id],
      findings: [
        finding('rejected_result', [conflictBand.id], '冲突决定：后一决定为当前投影，旧决定可回溯', {}, conflictMw ? [] : [], [conflictBand.id]),
      ],
    },
  );

  return {
    events,
    imageMaterial,
    ladderSpec,
    lanes,
    bands,
    estimates,
    profiles: pipe.profiles,
    calibrationId,
    writer,
    acceptedBandId: firstUnique.bandId,
    rejectedBandId: rejectTarget.id,
    revisedBandId: revised.id,
    acceptedMwId: firstUnique.id,
  };
}

function bandFindings(bands: Band[]): FindingPayload[] | undefined {
  const out: FindingPayload[] = [];
  const sat = bands.filter((b) => b.saturated);
  if (sat.length) {
    out.push(
      finding(
        'saturated_candidate',
        sat.map((b) => b.id),
        '饱和条带峰中心被平台截断：只能标为候选或区间',
        { plateauPxList: sat.map((b) => b.saturatedPlateauPx) },
      ),
    );
  }
  const tail = bands.filter((b) => b.tailingAsymmetry >= 1.6);
  if (tail.length) {
    out.push(
      finding(
        'tailing_candidate',
        tail.map((b) => b.id),
        '拖尾条带质心不稳：只能标为候选',
        { asymmetryList: tail.map((b) => b.tailingAsymmetry) },
      ),
    );
  }
  const overlap = bands.filter((b) => b.overlapGroupId);
  if (overlap.length) {
    out.push(
      finding(
        'overlap_interval',
        overlap.map((b) => b.id),
        '重叠带无法唯一拆分：保留区间与全部合法候选',
        { groups: [...new Set(overlap.map((b) => b.overlapGroupId))] },
      ),
    );
  }
  return out.length ? out : undefined;
}

function missingFindings(calibration: ReturnType<typeof runPipeline>['calibration']): FindingPayload[] {
  if (!calibration) return [];
  const missing = calibration.pairing.filter((p) => !p.matched);
  if (!missing.length) return [];
  return [
    finding(
      'missing_ladder_band',
      missing.map((p) => `rank:${p.rank}`),
      'ladder 缺带：对应迁移范围无有效插值段，缺带两侧不做跨越推断',
      { ranks: missing.map((p) => p.rank) },
    ),
  ];
}

function reviseBandCenter(band: Band, lane: Lane, eventId: string, deltaY: number): Band {
  const center: Band['center'] = {
    x: band.center.x,
    y: band.center.y + deltaY,
    frame: 'image_px',
    provenance: { origin: 'manual_pixel', imageMaterialId: band.center.provenance.imageMaterialId, eventId, method: 'manual.center.revise' },
  };
  const near = nearestS(lane.center, { x: center.x, y: center.y });
  return {
    ...band,
    id: stableId('band', lane.id, 1, center.x, center.y),
    center,
    migrationS: { value: Number(near.s.toFixed(2)), unit: 'pixel', frame: 'lane_arc' },
    status: 'candidate',
    origin: 'revised',
    parentId: band.id,
    diagnosticCodes: [...new Set([...band.diagnosticCodes, D.REVISION_LOCAL_INVALIDATION])],
  };
}
