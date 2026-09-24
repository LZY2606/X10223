import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  BandCenterMaterial,
  Event,
  EventType,
  GelParams,
  LaneBoundaryMaterial,
  Material,
  PixelPoint
} from '../shared/types.js';
import { PARAMS_V1 } from '../shared/types.js';
import { appendEvent, putImage, putMaterial, recordResults, resetAll } from './db.js';
import { replayAt } from './state.js';
import { buildMaterials, generateGel, BASELINE_VARIANT, CASE_ID } from './gelgen.js';
import type { GelVariant } from './gelgen.js';

const BASE_TIME = Date.parse('2026-09-25T08:00:00.000Z');
const stamp = (seq: number) => new Date(BASE_TIME + seq * 60000).toISOString();

const sha = (buf: Buffer) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

const PARAMS_V2: GelParams = {
  ...PARAMS_V1,
  paramsVersion: 'params-v2',
  saturationThreshold: 240,
  minBandSeparationPx: 9
};

interface CommitOpts {
  branch: string;
  type: EventType;
  payload: Record<string, unknown>;
  parents: string[];
  paramsVersion: string;
  materials?: Material[];
  images?: { id: string; png: Buffer; workingPng: Buffer }[];
  imageSha?: Record<string, string>;
}

export function seedDatabase(db: DatabaseSync): void {
  resetAll(db);

  const baselineGel = generateGel(BASELINE_VARIANT);
  const rotatedGel = generateGel({ ...BASELINE_VARIANT, rotate: true } satisfies GelVariant);

  const baseId = {
    image: 'img-baseline',
    nominal: 'lad-nominal-v1',
    boundaries: 'lan-baseline',
    bands: (laneId: string) => `bnd-baseline-${laneId}`
  };

  const built = buildMaterials(baselineGel, {
    imageId: baseId.image,
    nominalId: baseId.nominal,
    boundariesId: baseId.boundaries,
    bandIdPrefix: 'bnd-baseline',
    orientation: { rotationDeg: 0, mirrored: false },
    sha256: sha(baselineGel.png),
    capturedAt: '2026-09-25T07:42:10Z',
    exposure: { exposureMs: 120, gain: 1.4, detector: 'UV 302nm CCD' }
  });
  const baseMaterials: Material[] = [
    built.image,
    built.nominal,
    built.boundaries,
    ...built.bandMaterials
  ];

  const commit = (seq: number, opts: CommitOpts): Event => {
    for (const im of opts.images ?? []) {
      putImage(db, im.id, im.png, im.workingPng, opts.imageSha?.[im.id] ?? sha(im.png), seq);
    }
    for (const m of opts.materials ?? []) putMaterial(db, m, opts.branch, `evt-${String(seq).padStart(4, '0')}`, seq);
    const ev = appendEvent(db, {
      branch: opts.branch,
      type: opts.type,
      parents: opts.parents,
      paramsVersion: opts.paramsVersion,
      createdAt: stamp(seq),
      payload: opts.payload,
      seq
    });
    const replay = replayAt(db, opts.branch, seq, { persist: true });
    if (!replay) throw new Error(`replay failed at seq ${seq}`);
    void recordResults;
    return ev;
  };

  const baseBandIds = built.bandMaterials.map((b) => b.id);

  // —— 主时间线 ——
  commit(1, {
    branch: 'main',
    type: 'case-imported',
    paramsVersion: PARAMS_V1.paramsVersion,
    materials: baseMaterials,
    images: [{ id: baseId.image, png: baselineGel.png, workingPng: baselineGel.png }],
    parents: [baseId.image, baseId.nominal, baseId.boundaries, ...baseBandIds],
    payload: {
      caseId: CASE_ID,
      materialId: baseId.image,
      imageId: baseId.image,
      note: '初始导入：原图/拍摄方向/曝光/ladder 标称值/lane 边界/条带中心，均为像素级来源材料',
      orientation: { rotationDeg: 0, mirrored: false },
      exposureMs: 120,
      unitSystem: { size: 'bp', coordinates: 'working-pixel top-left x-right/y-down', time: 'ISO8601' }
    }
  });

  commit(2, {
    branch: 'main',
    type: 'auto-candidates',
    paramsVersion: PARAMS_V1.paramsVersion,
    parents: [baseId.image, baseId.nominal, baseId.boundaries, ...baseBandIds, 'params-v1', 'evt-0001'],
    payload: {
      materialId: undefined,
      note: '自动候选：沿弯曲泳道弧长做局部 log-linear 标尺；饱和/拖尾仅给候选或区间'
    }
  });

  // 审阅：采纳 lane-1 第 0 档自动候选
  commit(3, {
    branch: 'main',
    type: 'human-decision',
    paramsVersion: PARAMS_V1.paramsVersion,
    parents: ['evt-0002'],
    payload: { laneId: 'lane-1', bandIndex: 0, verdict: 'accept', note: '采纳自动候选分子量' }
  });

  // 审阅：否定 lane-3 饱和档（只能是区间，不接受单一值）
  commit(4, {
    branch: 'main',
    type: 'human-decision',
    paramsVersion: PARAMS_V1.paramsVersion,
    parents: ['evt-0002'],
    payload: { laneId: 'lane-3', bandIndex: 1, verdict: 'reject', note: '饱和档，拒绝单一分子量，保留区间' }
  });

  // 参数修订（v1 -> v2）：所有泳道结果因参数版本变化而重算
  commit(5, {
    branch: 'main',
    type: 'params-revised',
    paramsVersion: PARAMS_V2.paramsVersion,
    parents: ['params-v1', 'evt-0002'],
    payload: {
      params: PARAMS_V2,
      note: '饱和阈值 250->240、最小间距 10->9px；参数版本升级，结果携带新 paramsVersion'
    }
  });

  // 互相冲突的人工决定（同一目标 lane-2/band0）：A 接受自动值
  commit(6, {
    branch: 'main',
    type: 'conflict-recorded',
    paramsVersion: PARAMS_V2.paramsVersion,
    parents: ['evt-0005'],
    payload: {
      laneId: 'lane-2',
      bandIndex: 0,
      verdict: 'accept',
      proposer: 'reviewer-A',
      note: '审阅者 A：接受自动候选'
    }
  });
  // B 否定并调整为人工值
  commit(7, {
    branch: 'main',
    type: 'conflict-recorded',
    paramsVersion: PARAMS_V2.paramsVersion,
    parents: ['evt-0006'],
    payload: {
      laneId: 'lane-2',
      bandIndex: 0,
      verdict: 'adjust',
      adjustedSizeBp: 6800,
      unit: 'bp',
      proposer: 'reviewer-B',
      note: '审阅者 B：人工修订为 6800 bp'
    }
  });
  commit(8, {
    branch: 'main',
    type: 'conflict-resolved',
    paramsVersion: PARAMS_V2.paramsVersion,
    parents: ['evt-0006', 'evt-0007'],
    payload: {
      laneId: 'lane-2',
      bandIndex: 0,
      winningEventId: 'evt-0007',
      note: '仲裁采纳 B 的人工值；A 的结果仍保留为未采纳历史'
    }
  });

  // 只影响局部依赖的源数据改动：仅修订 lane-1 中心线（其它泳道身份/数值不变）
  const revisedBoundaries: LaneBoundaryMaterial = {
    ...built.boundaries,
    id: 'lan-main-lane1-revised',
    lanes: built.boundaries.lanes.map((lane) =>
      lane.laneId === 'lane-1'
        ? { ...lane, centerline: lane.centerline.map((p) => ({ ...p, y: p.y + 3.5 })) }
        : lane
    )
  };
  commit(9, {
    branch: 'main',
    type: 'source-revised',
    paramsVersion: PARAMS_V2.paramsVersion,
    materials: [revisedBoundaries],
    parents: ['lan-baseline', 'evt-0008'],
    payload: {
      materialId: revisedBoundaries.id,
      singleSourceSlot: 'lane-boundaries:lane-1',
      note: '仅改动 lane-1 边界这一个直接来源，检验局部失效范围'
    }
  });

  // —— 反例档案：7 个分支，各自只改一个直接来源 ——
  const forkBranch = (
    seqStart: number,
    bid: string,
    variant: GelVariant,
    singleSource: string,
    optsFork: { rotateWorkingPng?: Buffer; mutate?: (ms: Material[], gel: ReturnType<typeof generateGel>) => Material[]; forkPoint?: string; paramsVersion?: GelParams } = {}
  ): number => {
    const gel = generateGel(variant);
    const orientation = variant.rotate ? { rotationDeg: 90 as const, mirrored: false } : { rotationDeg: 0 as const, mirrored: false };
    const mb = buildMaterials(gel, {
      imageId: `img-${bid}`,
      nominalId: `lad-${bid}`,
      boundariesId: `lan-${bid}`,
      bandIdPrefix: `bnd-${bid}`,
      orientation,
      sha256: sha(gel.png),
      capturedAt: '2026-09-25T07:42:10Z',
      exposure: { exposureMs: 120, gain: 1.4, detector: 'UV 302nm CCD' }
    });
    let mats: Material[] = [mb.image, mb.nominal, mb.boundaries, ...mb.bandMaterials];
    if (optsFork.mutate) mats = optsFork.mutate(mats, gel);
    const ids = mats.map((m) => m.id);
    const workingPng = optsFork.rotateWorkingPng ?? gel.png;
    const forkPoint = optsFork.forkPoint ?? 'evt-0001';
    const pv = optsFork.paramsVersion ?? PARAMS_V1;
    commit(seqStart, {
      branch: bid,
      type: 'archive-mutation',
      paramsVersion: pv.paramsVersion,
      materials: mats,
      images: [{ id: `img-${bid}`, png: gel.png, workingPng }],
      imageSha: { [`img-${bid}`]: mb.image.sha256 },
      parents: [forkPoint, ...ids],
      payload: {
        materialId: `img-${bid}`,
        imageId: `img-${bid}`,
        singleSource,
        forkPoint,
        note: `反例：只改动直接来源 ${singleSource}`,
        orientation
      }
    });
    commit(seqStart + 1, {
      branch: bid,
      type: 'auto-candidates',
      paramsVersion: pv.paramsVersion,
      parents: [...ids, pv.paramsVersion, `evt-${String(seqStart).padStart(4, '0')}`],
      payload: { materialId: undefined, note: '反例分支自动候选重算，影响应限制在正确范围' }
    });
    return seqStart + 2;
  };

  let s = 10;
  s = forkBranch(s, 'arc-rotated', { ...BASELINE_VARIANT, rotate: true }, 'image.orientation', {
    rotateWorkingPng: baselineGel.png,
    note: undefined as never
  });
  s = forkBranch(s, 'arc-smile', { ...BASELINE_VARIANT, smileK: 34, weaveAmp: 6 }, 'lane-boundaries');
  s = forkBranch(s, 'arc-missing-ladder', { ...BASELINE_VARIANT, omitLadderIndex: 4 }, 'band-centers:lane-ladder');
  s = forkBranch(s, 'arc-saturated', BASELINE_VARIANT, 'band-centers:intensity', {
    mutate: (mats) =>
      mats.map((m) =>
        m.kind === 'band-centers' && m.laneId === 'lane-1'
          ? {
              ...m,
              bands: m.bands.map((b) =>
                b.bandIndex === 1
                  ? { ...b, saturated: true, intensity: 255, halfWidthPx: 7 }
                  : b
              )
            }
          : m
      )
  });
  s = forkBranch(s, 'arc-overlap', BASELINE_VARIANT, 'band-centers:added-bands', {
    mutate: (mats, gel) => {
      // 同一份原图不重新生成；复用现有 blob 附近标注两条重叠中心（仅改条带中心这一来源）
      const lane2 = gel.bands['lane-2'];
      const anchor = lane2.find((b) => b.bandIndex === 1)!;
      const addA: import('../shared/types.js').BandSpec = {
        bandIndex: 3,
        x: anchor.x,
        y: anchor.y - 3.1,
        pixelSource: { x: Math.round(anchor.x), y: Math.round(anchor.y - 3.1) },
        intensity: 205,
        saturated: false,
        tailing: false,
        halfWidthPx: 4
      };
      const addB: import('../shared/types.js').BandSpec = {
        ...addA,
        bandIndex: 4,
        y: anchor.y + 3.1,
        pixelSource: { x: Math.round(anchor.x), y: Math.round(anchor.y + 3.1) }
      };
      return mats.map((m): Material =>
        m.kind === 'band-centers' && m.laneId === 'lane-2' ? { ...m, bands: [...m.bands, addA, addB] } : m
      );
    }
  });
  s = forkBranch(s, 'arc-nonmono', { ...BASELINE_VARIANT, swapLadder: [3, 5] }, 'band-centers:ladder-order');

  // 分支 7：修订后局部失效 —— fork 主时间线源改动之后，再只改 lane-1
  s = forkBranch(s, 'arc-local-invalidation', BASELINE_VARIANT, 'lane-boundaries:lane-1', {
    forkPoint: 'evt-0009',
    paramsVersion: PARAMS_V2,
    mutate: (mats) => {
      const mutated = mats.map((m): Material =>
        m.kind === 'lane-boundaries'
          ? {
              ...m,
              lanes: m.lanes.map((lane) =>
                lane.laneId === 'lane-1'
                  ? { ...lane, centerline: lane.centerline.map((p): PixelPoint => ({ ...p, y: p.y + 6 })) }
                  : lane
              )
            }
          : m
      );
      return mutated;
    }
  });

  // 导出标记事件（不改变状态，仅记录工作流节点）
  commit(s, {
    branch: 'main',
    type: 'exported',
    paramsVersion: PARAMS_V2.paramsVersion,
    parents: ['evt-0009'],
    payload: { caseId: CASE_ID, note: '案例包导出：身份/顺序/来源关系随档案保存' }
  });
}
