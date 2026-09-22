import type {
  BandAnnotationMaterial, Event, LadderSpecMaterial, LaneCurve,
  LaneGeometryMaterial, Material, OrientationMaterial,
} from '../shared/types.js';
import { contentId } from '../shared/digest.js';
import { WELL_Y, LANE_LENGTH, LANE_X, LANE_IDS } from '../../scripts/bp-layout.js';
import { smilingLanePoints } from './curves.js';

export interface BranchSeed {
  branchId: string; name: string; purpose: string;
  events: Array<{ type: Event['type']; payload: Record<string, unknown> }>;
  imageSha?: string;      // 该分支使用的（只改一个来源后的）图像 sha
  imageFile?: string;
}

// 为每个反例场景构造“基线 -> 只改一个直接来源 -> 局部参数修订”事件序列
export function buildBranchSeeds(ctx: {
  imageBaseSha: string;
  imageByFile: Record<string, { sha: string }>;
  materials: Material[];
}): BranchSeed[] {
  const geo = ctx.materials.find((m) => m.type === 'lane-geometry') as LaneGeometryMaterial;
  const bandsMat = ctx.materials.find((m) => m.type === 'band-annotation') as BandAnnotationMaterial;
  const ladder = ctx.materials.find((m) => m.type === 'ladder-spec') as LadderSpecMaterial;

  const seeds: BranchSeed[] = [];

  // 基线主分支：确认方向 + 一次参数修订 + 一次互相冲突的人工决定（两条分支各自决定，冲突仅引用不覆盖）
  seeds.push({
    branchId: 'br-main', name: 'main（基线叙事）', purpose: '初始导入 → 核对像素来源 → 参数修订 → 人工决定',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
    ],
  });

  seeds.push({
    branchId: 'br-rotated', name: '旋转图像', purpose: '只改拍摄方向确认（90°），材料像素不动',
    imageFile: 'scenarios/rotated-image.png',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 90, wellsAt: 'left' } },
    ],
  });

  // 弯曲泳道：新几何材料版本（微笑）+ 对应图像
  const smileGeo: LaneGeometryMaterial = {
    ...geo,
    id: 'geo-smile-v2',
    lanes: geo.lanes.map((lane) => ({
      ...lane,
      points: lane.role === 'ladder'
        ? lane.points
        : smilingLanePoints(LANE_X[lane.ordinal], WELL_Y, LANE_LENGTH, 10),
      provenance: { ...lane.provenance, materialId: 'geo-smile-v2', fieldPath: `lanes[${lane.ordinal}].points`, method: 'manual' },
    })),
    provenance: { ...geo.provenance, materialId: 'geo-smile-v2', method: 'manual' },
  };
  seeds.push({
    branchId: 'br-curved', name: '弯曲泳道（微笑）', purpose: '只改 lane 曲线这一个直接来源，验证局部标尺有效区域',
    imageFile: 'scenarios/curved-lanes.png',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
      {
        type: 'source-patch',
        payload: {
          target: 'lanes:curves', materialId: smileGeo.id, fieldPath: 'lanes[*].points',
          newMaterialId: smileGeo.id, summary: '直线中心线 -> 微笑曲线（amp=10px）',
          scope: { laneIds: LANE_IDS.slice(1) }, newGeometry: smileGeo,
        },
      },
    ],
  });

  seeds.push({
    branchId: 'br-missing', name: 'ladder 缺带', purpose: '只改像素：抹除 500bp 带',
    imageFile: 'scenarios/ladder-missing-band.png',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
      {
        type: 'source-patch',
        payload: {
          target: 'image:pixels', materialId: 'img-baseline', fieldPath: 'pixels@lane-L:s158',
          newMaterialId: 'img-missing-500', summary: '仅抹除 ladder 500bp 槽位条带',
          imageSha256: ctx.imageByFile['scenarios/ladder-missing-band.png'].sha,
          scope: { laneIds: ['lane-L'] },
        },
      },
    ],
  });

  seeds.push({
    branchId: 'br-saturated', name: '饱和区', purpose: '只改像素：lane-5 一条带打饱和',
    imageFile: 'scenarios/saturated-band.png',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
      {
        type: 'source-patch',
        payload: {
          target: 'image:pixels', materialId: 'img-baseline', fieldPath: 'pixels@lane-5:s130',
          newMaterialId: 'img-sat', summary: '仅把 lane-5 s=130 条带中心置 255',
          imageSha256: ctx.imageByFile['scenarios/saturated-band.png'].sha,
          scope: { laneIds: ['lane-5'] },
        },
      },
    ],
  });

  seeds.push({
    branchId: 'br-overlap', name: '两条带重叠', purpose: '只改像素：lane-3 间距 6px',
    imageFile: 'scenarios/overlap-two-bands.png',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
    ],
  });

  // 非单调标尺：交换标称（新材料版本）
  const nonMono: LadderSpecMaterial = {
    ...ladder, id: 'ladder-nonmono-v2',
    entries: ladder.entries.map((e) => {
      if (e.ordinal === 3) return { ...e, nominalBp: 500, raw: '500bp', id: 'nom-500-x' };
      if (e.ordinal === 4) return { ...e, nominalBp: 750, raw: '750bp', id: 'nom-750-x' };
      return e;
    }),
    provenance: { ...ladder.provenance, materialId: 'ladder-nonmono-v2', method: 'manual' },
  };
  seeds.push({
    branchId: 'br-nonmono', name: '非单调标尺', purpose: '只改 ladder 标称顺序 -> 语义无解',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
      {
        type: 'source-patch',
        payload: {
          target: 'ladder:nominal', materialId: nonMono.id, fieldPath: 'entries[3,4].nominalBp',
          newMaterialId: nonMono.id, summary: '交换 750/500 标称，制造非单调',
          scope: {}, newLadder: nonMono,
        },
      },
    ],
  });

  seeds.push({
    branchId: 'br-local-invalidation', name: '参数修订后局部失效', purpose: '只改参数版本，验证仅 lane-5 失效',
    events: [
      { type: 'orientation-confirmed', payload: { rotationApplied: 0, wellsAt: 'top' } },
      {
        type: 'param-revision',
        payload: { fromVersion: 'params-001-v1', toVersion: 'params-002-saturation-200', reason: '饱和阈值收紧到 200' },
      },
    ],
  });

  return seeds;
}

void contentId;
