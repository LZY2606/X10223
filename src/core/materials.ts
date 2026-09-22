import type {
  BandCenterMaterial,
  ExposureMaterial,
  GelImageMaterial,
  LadderSpecMaterial,
  LaneGeometryMaterial,
  Material,
  OrientationMaterial,
  PixelProvenance,
  Point,
  Provenance,
  Quant,
} from './types.js';
import { canonicalJSON, contentId } from './ids.js';

let clock = 0;
/** 确定性逻辑时钟：材料 createdAt 稳定（与真实时钟解耦，可由生成器注入）。 */
export function nextTick(start = 1): number {
  clock = Math.max(clock, start);
  return clock++;
}
export function resetTick(n = 1): void {
  clock = n;
}

export function materialHash(m: Material): string {
  const { id: _id, ...body } = m as Material & { id?: string };
  void _id;
  return contentId('mat', canonicalJSON(body));
}

function withId<M extends Material>(projectId: string, partial: Omit<M, 'id' | 'projectId'>): M {
  const id = contentId('mat', projectId, canonicalJSON(partial));
  return { ...(partial as object), id, projectId } as M;
}

export function pixelProv(
  imageId: string,
  x: number,
  y: number,
  frame: 'original' | 'rotated' = 'original',
  extra: Partial<PixelProvenance> = {},
): PixelProvenance {
  return {
    kind: 'pixel',
    imageId,
    x: { value: x, unit: 'pixel' },
    y: { value: y, unit: 'pixel' },
    frame,
    ...extra,
  };
}

export function makeImage(
  projectId: string,
  args: {
    origin: 'auto' | 'human' | 'vendor';
    pngSha256: string;
    width: number;
    height: number;
    isOriginal: boolean;
    derivedFrom?: { parentImageId: string; clockwiseDegrees: number };
    provenance: Provenance[];
    rawRepresentation: unknown;
    createdAt?: number;
  },
): GelImageMaterial {
  return withId<GelImageMaterial>(projectId, {
    type: 'gel-image',
    origin: args.origin,
    pngSha256: args.pngSha256,
    width: { value: args.width, unit: 'pixel' },
    height: { value: args.height, unit: 'pixel' },
    channels: 1,
    isOriginal: args.isOriginal,
    ...(args.derivedFrom ? { derivedFrom: args.derivedFrom } : {}),
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: args.createdAt ?? nextTick(),
  });
}

export function makeOrientation(
  projectId: string,
  args: {
    imageId: string;
    loadingWellSide: OrientationMaterial['loadingWellSide'];
    rotateClockwise: number;
    origin: 'auto' | 'human';
    provenance: Provenance[];
    rawRepresentation: unknown;
  },
): OrientationMaterial {
  return withId<OrientationMaterial>(projectId, {
    type: 'orientation',
    imageId: args.imageId,
    loadingWellSide: args.loadingWellSide,
    rotateClockwise: { value: args.rotateClockwise, unit: 'degree' },
    origin: args.origin,
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: nextTick(),
  });
}

export function makeExposure(
  projectId: string,
  args: {
    imageId: string;
    exposureMs: number;
    gain: number;
    saturationGray: number;
    bitDepth: number;
    origin: 'auto' | 'human' | 'vendor';
    provenance: Provenance[];
    rawRepresentation: unknown;
  },
): ExposureMaterial {
  return withId<ExposureMaterial>(projectId, {
    type: 'exposure',
    imageId: args.imageId,
    exposureTime: { value: args.exposureMs, unit: 'ms' },
    gain: { value: args.gain, unit: 'ratio' },
    saturationGray: { value: args.saturationGray, unit: 'graylevel' },
    bitDepth: { value: args.bitDepth, unit: 'count' },
    origin: args.origin,
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: nextTick(),
  });
}

export function makeLaneGeometry(
  projectId: string,
  args: {
    imageId: string;
    lanes: import('./types.js').LaneSpec[];
    origin: 'auto' | 'human';
    provenance: Provenance[];
    rawRepresentation: unknown;
  },
): LaneGeometryMaterial {
  return withId<LaneGeometryMaterial>(projectId, {
    type: 'lane-boundaries',
    imageId: args.imageId,
    lanes: args.lanes,
    origin: args.origin,
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: nextTick(),
  });
}

export function makeBandCenters(
  projectId: string,
  args: {
    imageId: string;
    laneId: string;
    centers: PixelProvenance[];
    origin: 'auto' | 'human';
    provenance: Provenance[];
    rawRepresentation: unknown;
  },
): BandCenterMaterial {
  return withId<BandCenterMaterial>(projectId, {
    type: 'band-centers',
    imageId: args.imageId,
    laneId: args.laneId,
    centers: args.centers,
    origin: args.origin,
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: nextTick(),
  });
}

export function makeLadderSpec(
  projectId: string,
  args: {
    ladderLaneId: string;
    productName: string;
    bands: import('./types.js').LadderBandNominal[];
    origin: 'vendor' | 'human';
    provenance: Provenance[];
    rawRepresentation: unknown;
  },
): LadderSpecMaterial {
  return withId<LadderSpecMaterial>(projectId, {
    type: 'ladder-spec',
    ladderLaneId: args.ladderLaneId,
    productName: args.productName,
    bands: args.bands,
    origin: args.origin,
    provenance: args.provenance,
    rawRepresentation: args.rawRepresentation,
    createdAt: nextTick(),
  });
}

export function quant(value: number, unit: Quant['unit'], raw?: string): Quant {
  return raw ? { value, unit, raw } : { value, unit };
}

export function point(x: number, y: number): Point {
  return { x: { value: x, unit: 'pixel' }, y: { value: y, unit: 'pixel' } };
}
