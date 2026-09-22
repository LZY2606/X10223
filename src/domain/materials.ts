import type {
  BandCenterMaterial,
  ExposureMaterial,
  ImageMaterial,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  Material,
  MaterialRecord,
  OrientationMaterial,
  ScenarioId
} from '../shared/types.ts';
import { IMAGE_HEIGHT, IMAGE_WIDTH, LANE_X, makeDefaultLaneCurves } from './image.ts';
import type { Point } from './geometry.ts';
import { stableId } from './identity.ts';

export const PROJECT_ID = 'proj_gel_evidence_001';
export const FRAME_SOURCE = 'frame-source-v1';
export const FRAME_CORRECTED = 'frame-corrected-v1';

export const baselineLadderYs = [72, 108, 151, 204, 268, 335, 405, 455];
export const baselineNominalBp = [10000, 5000, 3000, 2000, 1500, 1000, 500, 200];

export const baselineSampleBands = [
  { id: 'manual-lane-2-band-1', laneId: 'lane-2', y: 132, observedAs: 'point' as const },
  { id: 'manual-lane-2-band-2', laneId: 'lane-2', y: 292, observedAs: 'point' as const },
  { id: 'manual-lane-3-band-1', laneId: 'lane-3', y: 181, observedAs: 'tail' as const },
  { id: 'manual-lane-4-band-1', laneId: 'lane-4', y: 237, observedAs: 'point' as const },
  { id: 'manual-lane-5-band-1', laneId: 'lane-5', y: 315, observedAs: 'point' as const },
  { id: 'manual-lane-6-band-1', laneId: 'lane-6', y: 382, observedAs: 'point' as const },
  { id: 'manual-lane-7-band-1', laneId: 'lane-7', y: 430, observedAs: 'point' as const }
];

export function imageMaterial(scenario: ScenarioId, sha256: string, width = IMAGE_WIDTH, height = IMAGE_HEIGHT, rotationDeg = 0): ImageMaterial {
  return {
    kind: 'image',
    fileName: `${scenario}.png`,
    mediaType: 'image/png',
    width: { value: width, unit: 'px' },
    height: { value: height, unit: 'px' },
    sha256: { value: sha256, unit: 'sha256-hex' },
    blobPath: `images/${scenario}.png`,
    pixelFrame: rotationDeg === 0 ? FRAME_CORRECTED : FRAME_SOURCE,
    scenario,
    originalRepresentation: { colorModel: 'RGBA-grayscale-render', bitsPerChannel: 8, origin: 'top-left' }
  };
}

export function orientationMaterial(deg = 0): OrientationMaterial {
  return {
    kind: 'orientation',
    upDirection: 'top-is-electrode-negative',
    migrationDirection: 'downward-after-correction',
    sourceToDisplayClockwiseDeg: { value: deg, unit: 'degree' },
    sourceFrame: FRAME_SOURCE,
    correctedFrame: FRAME_CORRECTED,
    uncertaintyDeg: { value: 0, unit: 'degree' },
    evidence: 'capture-manifest'
  };
}

export function exposureMaterial(exposureMs = 650): ExposureMaterial {
  return {
    kind: 'exposure',
    exposure: { value: exposureMs, unit: 'ms' },
    gain: { value: 1, unit: 'dimensionless' },
    gamma: { value: 1, unit: 'dimensionless' },
    saturationLevel: { value: 255, unit: 'graylevel-8' },
    source: 'capture-manifest'
  };
}

export function nominalMaterial(values = baselineNominalBp): LadderNominalMaterial {
  return {
    kind: 'ladderNominal',
    laneId: 'lane-1',
    order: 'top-to-bottom-in-corrected-frame',
    unit: 'bp',
    bands: values.map((value, index) => ({
      id: `nominal-ladder-${index + 1}`,
      molecularWeight: { value, unit: 'bp' },
      expectedRank: { value: index + 1, unit: 'count' },
      originalToken: `${value} bp`
    }))
  };
}

function boundaryFromCurves(curves: Record<string, Point[]>, scenario: ScenarioId, provenance: 'auto-v1' | 'manual-v1'): LaneBoundaryMaterial {
  return {
    kind: 'laneBoundary',
    provenance,
    lanes: LANE_X.map((_, index) => {
      const laneId = `lane-${index + 1}`;
      const points = (curves[laneId] as Array<{ x: number; y: number }>).map((point) => ({ ...point }));
      return {
        id: laneId,
        role: index === 0 ? 'ladder' as const : 'sample' as const,
        left: { points: points.map((point) => ({ x: point.x - 20, y: point.y })), frame: FRAME_CORRECTED, unit: 'px' },
        center: { points, frame: FRAME_CORRECTED, unit: 'px' },
        right: { points: points.map((point) => ({ x: point.x + 20, y: point.y })), frame: FRAME_CORRECTED, unit: 'px' },
        sourceFrame: FRAME_CORRECTED,
        confidence: { value: scenario === 'smile' && laneId === 'lane-3' ? 0.86 : 0.96, unit: 'dimensionless' }
      };
    })
  };
}

export function manualLaneMaterial(scenario: ScenarioId): LaneBoundaryMaterial {
  return boundaryFromCurves(makeDefaultLaneCurves(scenario), scenario, 'manual-v1');
}

export function autoLaneMaterial(scenario: ScenarioId): LaneBoundaryMaterial {
  return boundaryFromCurves(makeDefaultLaneCurves(scenario), scenario, 'auto-v1');
}

export function manualBandMaterial(
  scenario: ScenarioId,
  overrides: Partial<Record<string, Array<{ id: string; laneId: string; y: number; observedAs: BandCenterMaterial['bands'][number]['observedAs']; nominalBandId?: string }>>> = {}
): BandCenterMaterial {
  const ladder = (overrides.ladder ?? baselineLadderYs.map((y, index) => ({
    id: `manual-ladder-band-${index + 1}`,
    laneId: 'lane-1',
    y,
    observedAs: 'point' as const,
    nominalBandId: `nominal-ladder-${index + 1}`
  })));
  const samples = overrides.sample ?? baselineSampleBands;
  const xForLane = (laneId: string) => {
    const curve = makeDefaultLaneCurves(scenario)[laneId]!;
    return (y: number) => curve.find((point, index) => index < curve.length - 1 && point.y <= y && curve[index + 1]!.y >= y)?.x ?? curve.at(-1)!.x;
  };
  return {
    kind: 'bandCenter',
    provenance: 'manual-v1',
    bands: [...ladder, ...samples].map((band) => ({
      id: band.id,
      laneId: band.laneId,
      role: band.laneId === 'lane-1' ? 'ladder' as const : 'sample' as const,
      nominalBandId: band.nominalBandId,
      center: { x: xForLane(band.laneId)(band.y), y: band.y, frame: FRAME_CORRECTED },
      source: 'manual-v1' as const,
      observedAs: band.observedAs
    }))
  };
}

export function materialRecord(projectId: string, material: Material, createdAt: string, supersedesId?: string): MaterialRecord {
  const kind = material.kind;
  const id = stableId(`material-${kind}`, [projectId, material, createdAt, supersedesId ?? '']);
  return {
    id,
    projectId,
    kind: material.kind,
    createdAt,
    supersedesId,
    scope: 'global',
    checksum: stableId('checksum', material),
    material
  };
}
