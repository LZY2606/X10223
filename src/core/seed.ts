import type {
  Band,
  CalibrationParameters,
  CounterCaseScenario,
  EventType,
  GelEvent,
  GelImage,
  LadderBandNominal,
  Lane,
  OrientationDeg,
  Point,
} from './types.ts';
import { DEFAULT_PARAMETERS } from './types.ts';
import { buildGel, type BuiltGel, type GelBlueprint } from './gelkit.ts';
import { ALL_BLUEPRINTS, BASELINE_BLUEPRINT } from './cases.ts';
import { inferMolecularWeights } from './calibration.ts';
import { buildArcTable, projectToLane, rotatePoint } from './geometry.ts';
import { commandId, sha256Hex } from './ids.ts';

export const PROJECT_ID = 'proj_gel_bench_001';
export const T0 = '2026-09-25T03:00:00.000Z';

export interface SeedResult {
  projectId: string;
  events: GelEvent[];
  scenarios: CounterCaseScenario[];
  blobs: { sha256: string; contentType: string; bytes: Buffer }[];
}

class EventBuilder {
  seq = 0;
  events: GelEvent[] = [];
  blobs = new Map<string, Buffer>();

  constructor(public projectId: string) {}

  emit<T extends EventType>(
    branch: string,
    type: T,
    payload: GelEvent<T>['payload'],
    opts: { parent?: string | null; forkedFrom?: string; actor?: GelEvent['actor']; time?: string } = {},
  ): GelEvent<T> {
    this.seq += 1;
    const parent = opts.parent === undefined ? this.branchHead(branch) : opts.parent;
    const ev: GelEvent<T> = {
      id: commandId('ev'),
      projectId: this.projectId,
      seq: this.seq,
      branch,
      parentEventId: parent,
      forkedFromEventId: opts.forkedFrom,
      type,
      payload,
      payloadSummary: sha256Hex(payload),
      time: opts.time ?? T0,
      actor: opts.actor ?? 'seed',
    };
    this.events.push(ev);
    return ev;
  }

  branchHead(branch: string): string | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].branch === branch) return this.events[i].id;
    }
    return null;
  }

  rememberBlob(image: GelImage, png: Buffer) {
    this.blobs.set(image.blobSha256, png);
  }
}

export function seedProject(): SeedResult {
  const b = new EventBuilder(PROJECT_ID);
  const scenarios: CounterCaseScenario[] = [];

  b.emit('main', 'project_created', { name: '胶道标尺离线案例 · Lambda 风格 dsDNA 凝胶', unit: 'bp' }, { parent: null, time: T0 });

  // ---------- 主干基线 ----------
  const baseline = buildGel(ALL_BLUEPRINTS.baseline, 'main');
  b.rememberBlob(baseline.image, baseline.png);
  const baselineImport = b.emit('main', 'image_imported', { image: baseline.image }, { time: '2026-09-25T03:01:00.000Z' });
  b.emit('main', 'exposure_set', { imageId: baseline.image.id, exposure: baseline.image.exposure }, { time: '2026-09-25T03:01:10.000Z' });
  for (const lane of baseline.lanes) b.emit('main', 'lane_added', { lane }, { time: '2026-09-25T03:02:00.000Z' });
  b.emit('main', 'ladder_lane_assigned', { laneId: 'lane_ladder' }, { time: '2026-09-25T03:02:10.000Z' });
  for (const lb of baseline.ladderBands) b.emit('main', 'ladder_band_nominated', { band: lb }, { time: '2026-09-25T03:02:20.000Z' });
  b.emit('main', 'band_detected', { bands: baseline.bands }, { time: '2026-09-25T03:02:30.000Z' });

  const runV1 = recordInference(b, 'main', baseline, DEFAULT_PARAMETERS, [baselineImport.id], '2026-09-25T03:03:00.000Z', 'auto');

  // 人工修订：审阅者把 b_s2_a 中心从自动候选 y=112 微调到 y=109（像素级来源 manual）
  const revisedBand: Band = {
    ...baseline.bands.find((x) => x.id === 'b_s2_a')!,
    center: { x: baseline.bands.find((x) => x.id === 'b_s2_a')!.center.x, y: 109, unit: 'px' },
    source: {
      ...baseline.bands.find((x) => x.id === 'b_s2_a')!.source,
      origin: 'manual',
      raw: { coords: [baseline.bands.find((x) => x.id === 'b_s2_a')!.center, { x: baseline.bands.find((x) => x.id === 'b_s2_a')!.center.x, y: 109 }] },
      note: '人工修订：条带中心上移 3px',
    },
  };
  b.emit('main', 'band_center_revised', { band: revisedBand, supersedes: 'b_s2_a' }, { actor: 'reviewer', time: '2026-09-25T03:05:00.000Z' });

  // 修订后重新推断（仅 b_s2_a 的局部依赖变化，其他 band 结果身份不变）
  const afterManualBands = baseline.bands.map((x) => (x.id === 'b_s2_a' ? revisedBand : x));
  const runV2 = recordInference(b, 'main', withBands(baseline, afterManualBands), DEFAULT_PARAMETERS, [runV1.id], '2026-09-25T03:05:30.000Z', 'reviewer');

  // 互相冲突的人工决定：同一结果先接受后否定，二者都保留
  const target = runV2.results.find((r) => r.bandId === 'b_s2_a')!;
  b.emit('main', 'decision_recorded', { targetResultId: target.id, verdict: 'accepted', reason: '与对照一致' }, { actor: 'reviewer', time: '2026-09-25T03:06:00.000Z' });
  b.emit('main', 'decision_recorded', { targetResultId: target.id, verdict: 'rejected', reason: '复核发现拖尾可疑，要求重跑' }, { actor: 'reviewer', time: '2026-09-25T03:06:30.000Z' });
  b.emit('main', 'archive_note', { text: '基线：自动候选与人工修订分子量并存，冲突决定均保留历史。' }, { time: '2026-09-25T03:07:00.000Z' });

  buildOrientationBranch(b, scenarios, baseline, baselineImport.id);
  buildSmileBranch(b, scenarios, baselineImport.id);
  buildMissingBranch(b, scenarios, baselineImport.id);
  buildNonmonoBranch(b, scenarios, baselineImport.id);
  buildSaturatedBranch(b, scenarios, baselineImport.id);
  buildOverlapBranch(b, scenarios, baselineImport.id);
  buildParamsBranch(b, scenarios, baseline, baselineImport.id);

  return { projectId: PROJECT_ID, events: b.events, scenarios, blobs: [...b.blobs].map(([sha256, bytes]) => ({ sha256, contentType: 'image/png', bytes })) };
}
