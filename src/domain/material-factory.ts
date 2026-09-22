import type {
  BandCenterMaterial,
  ExposureMaterial,
  ImageMaterial,
  LadderNominalMaterial,
  LaneTraceMaterial,
  OrientationMaterial,
  PixelPoint,
  UnitName,
} from './types';
import { contentId } from './ids';
import { rotatePointCW } from './geometry';
import type { BuiltCase } from './casepack';

let clockCounter = 1000;
export function resetFactoryClock(start = 1000) {
  clockCounter = start;
}
function clk() {
  return clockCounter++;
}

export interface AssembledMaterials {
  image: ImageMaterial;
  orientation: OrientationMaterial;
  exposure: ExposureMaterial;
  ladder: LadderNominalMaterial;
  lanes: LaneTraceMaterial[];
}

/** 用案例包真值直接构建 lane 曲线材料（像素级来源保留为真值+原始像素坐标） */
export function buildMaterialsFromCase(args: {
  projectId?: string;
  projectName: string;
  pngBuffer: Buffer;
  width: number;
  height: number;
  laneXs: number[];
  laneWidth: number;
  originY: number;
  bend?: (y: number) => number;
  ladderSpec: { name: string; unit: UnitName; bands: { rank: number; mw: number; rawLabel: string }[] };
  rotationDeg?: number;
  saturatedPixels?: PixelPoint[];
  exposureMs?: number;
  blobSha256?: string;
}): AssembledMaterials {
  const {
    pngBuffer,
    width,
    height,
    laneXs,
    laneWidth,
    originY,
    bend,
    ladderSpec,
    rotationDeg = 0,
    saturatedPixels = [],
    exposureMs = 500,
  } = args;
  const projectId: string = args.projectId ?? '';

  // 旋转情形：入库的是“原始拍摄图”（旋转后），方向材料给出回正角度
  const effectiveW = rotationDeg === 90 || rotationDeg === 270 ? height : width;
  const effectiveH = rotationDeg === 90 || rotationDeg === 270 ? width : height;

  const blobSha256 = args.blobSha256 ?? contentId('blob', { bytesLen: pngBuffer.length, head: pngBuffer.subarray(0, 64).toString('hex') }).replace('blob_', 'sha_');
  const image: ImageMaterial = {
    id: contentId('mat_image', { project: projectId, sha: blobSha256, w: effectiveW, h: effectiveH }),
    projectId,
    type: 'image',
    blobSha256,
    width: effectiveW,
    height: effectiveH,
    channels: 1,
    bitDepth: 16,
    format: 'png',
    raw: { fileName: 'gel16.png', byteLength: pngBuffer.length, colorType: 'grayscale', bitDepth: 16 },
    provenance: { pixels: 'camera-raw:file/gel16.png' },
    importedAs: 'png-gray16-uint16',
    createdAtLogical: clk(),
  };

  const orientation: OrientationMaterial = {
    id: contentId('mat_orientation', { image: image.id, deg: rotationDeg }),
    projectId,
    type: 'orientation',
    imageId: image.id,
    rotationDeg,
    flipped: false,
    raw: { headerOrientation: rotationDeg === 0 ? 'wells-up' : 'rotated-cw90-to-fix', rawDegLabel: rotationDeg === 90 ? '90° CW' : '0°' },
    provenance: { rotationDeg: 'operator-note/orientation.txt' },
    importedAs: 'degCW',
    createdAtLogical: clk(),
  };

  const exposure: ExposureMaterial = {
    id: contentId('mat_exposure', { image: image.id, ms: exposureMs, max: 65535 }),
    projectId,
    type: 'exposure',
    imageId: image.id,
    exposureMs,
    gain: 1.0,
    maxEncoded: 65535,
    saturatedPixels,
    raw: { exposureMsText: `${exposureMs} ms`, gainText: '1.0x', cameraMax: '65535 (uint16)' },
    provenance: { exposureMs: 'capture-metadata/exposure.json#ms', saturatedPixels: 'pixel-scan:>=65535' },
    importedAs: 'ms+unitless+uint16',
    createdAtLogical: clk(),
  };

  const ladder: LadderNominalMaterial = {
    id: contentId('mat_ladder', { project: projectId, name: ladderSpec.name, bands: ladderSpec.bands }),
    projectId,
    type: 'ladder_nominal',
    name: ladderSpec.name,
    unit: ladderSpec.unit,
    bands: ladderSpec.bands.map((b) => ({
      rank: b.rank,
      molecularWeight: { value: b.mw, unit: ladderSpec.unit },
      rawLabel: b.rawLabel,
    })),
    raw: { sourceTable: ladderSpec.bands.map((b) => b.rawLabel) },
    provenance: Object.fromEntries(ladderSpec.bands.map((b) => [`bands[${b.rank - 1}]`, `manufacturer-sheet/${ladderSpec.name}.csv#rank${b.rank}`])),
    importedAs: 'raw-label',
    createdAtLogical: clk(),
  };

  const frameId = contentId('frame', { image: image.id, deg: rotationDeg });
  const lanes: LaneTraceMaterial[] = laneXs.map((x0, laneIndex) => {
    const role = laneIndex === 0 ? 'ladder' : 'sample';
    const centerline: PixelPoint[] = [];
    for (let y = originY; y <= height - 12; y += 8) {
      const base = { x: x0 + (bend ? bend(y) : 0), y };
      centerline.push(rotationDeg ? rotatePointCW(base, rotationDeg, width, height) : base);
    }
    const originBase: PixelPoint = { x: x0, y: originY };
    const origin = rotationDeg ? rotatePointCW(originBase, rotationDeg, width, height) : originBase;
    const half = laneWidth / 2;
    const mapPts = (pts: PixelPoint[]) =>
      pts.map((p) => (rotationDeg ? rotatePointCW(p, rotationDeg, width, height) : p));
    return {
      id: contentId('mat_lane', {
        project: projectId,
        frame: frameId,
        index: laneIndex,
        pts: centerline.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
        origin: [Math.round(origin.x * 10) / 10, Math.round(origin.y * 10) / 10],
      }),
      projectId,
      type: 'lane_trace',
      frameId,
      laneIndex,
      role: role as 'ladder' | 'sample',
      ladderNominalId: role === 'ladder' ? ladder.id : undefined,
      centerline: centerline.map((p) => ({ x: round1(p.x), y: round1(p.y) })),
      boundaryLeft: mapPts(centerline.map((p) => ({ x: p.x - half, y: p.y }))).map((p) => ({ x: round1(p.x), y: round1(p.y) })),
      boundaryRight: mapPts(centerline.map((p) => ({ x: p.x + half, y: p.y }))).map((p) => ({ x: round1(p.x), y: round1(p.y) })),
      origin: { x: round1(origin.x), y: round1(origin.y) },
      raw: { tracedBy: 'operator-polyline-v1', stepPx: 8 },
      provenance: {
        centerline: `image#${image.id}|pixels:operator-clicked-polyline`,
        boundaryLeft: `image#${image.id}|centerline+/-${half}px`,
        boundaryRight: `image#${image.id}|centerline+/-${half}px`,
      },
      importedAs: 'px,top-left',
      createdAtLogical: clk(),
    };
  });

  return { image, orientation, exposure, ladder, lanes };
}

/** 检测产物 band 转不可变材料（自动候选，带像素中心与轮廓来源） */
export function bandMaterial(
  projectId: string,
  frameId: string,
  laneId: string,
  center: PixelPoint,
  profile: { s: number; intensity: number }[],
  widthPx: number,
  flags: { saturated: boolean; tailing: boolean; overlapWith?: string },
  status: BandCenterMaterial['status'],
  author: 'auto' | 'human',
  imageId: string,
  exposureId: string
): BandCenterMaterial {
  return {
    id: contentId('mat_band', {
      lane: laneId,
      frame: frameId,
      x: round2(center.x),
      y: round2(center.y),
      status,
      author,
    }),
    projectId,
    type: 'band_center',
    laneId,
    frameId,
    center: { x: round2(center.x), y: round2(center.y) },
    profile,
    widthPx,
    saturated: flags.saturated,
    tailing: flags.tailing,
    overlapWith: flags.overlapWith,
    status,
    author,
    raw: { clickedOrDetected: author },
    provenance: {
      center: `image#${imageId}|pixels`,
      profile: `image#${imageId}|lane#${laneId}|profile`,
      saturated: `exposure#${exposureId}`,
    },
    importedAs: 'px+ratio',
    createdAtLogical: clk(),
  };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
function round2(v: number) {
  return Math.round(v * 100) / 100;
}
