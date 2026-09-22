import { contentId } from '../shared/ids.js';
import { uprightToRaw } from '../shared/geometry.js';
import { parseQuantity } from './quantity.js';
import { renderGel, type GelRecipe } from './gel-render.js';
import type {
  BandMaterial,
  CoordFrame,
  Diagnostic,
  ImageMaterial,
  LadderMaterial,
  LaneMaterial,
  MaterialBundle,
  Point,
  Quantity,
} from '../shared/types.js';

export interface BuiltCase {
  slug: string;
  name: string;
  bundle: MaterialBundle;
  pngBase64: string;
  /** 原始表示（导入时保留） */
  rawRepresentation: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

function toRaw(p: Point, frame: CoordFrame): Point {
  return uprightToRaw(p, frame);
}

function polyToRaw(points: Point[], frame: CoordFrame): Point[] {
  return points.map((p) => toRaw(p, frame));
}

export function buildCase(recipe: GelRecipe, name?: string): BuiltCase {
  const rendered = renderGel(recipe);
  const deg = recipe.orientationDeg ?? 0;
  const frame: CoordFrame = {
    kind: 'raw',
    rotationDeg: deg,
    unit: 'px',
    width: rendered.widthPx,
    height: rendered.heightPx,
  };

  const diagnostics: Diagnostic[] = [];
  const quantities: Quantity[] = [];
  const nominals = recipe.ladderNominals.map((n, i) => {
    const { q, diagnostics: d } = parseQuantity(n.raw, `ladderNominals[${i}]`, n.id, 'ladderNominal');
    diagnostics.push(...d);
    quantities.push(q);
    return { id: n.id, nominal: q, migrationHint: 1 - i / Math.max(1, recipe.ladderNominals.length - 1), missing: n.missing };
  });

  const image: ImageMaterial = {
    id: contentId('img', { slug: recipe.slug, sha: rendered.sha256 }),
    kind: 'image',
    filename: `${recipe.slug}.png`,
    mediaType: 'image/png',
    sha256: rendered.sha256,
    widthPx: rendered.widthPx,
    heightPx: rendered.heightPx,
    channels: 1,
    maxIntensity: rendered.maxIntensity,
    orientation: { degreesClockwise: deg, source: 'explicit' },
    exposure: {
      exposureTimeSec: recipe.exposureTimeSec ?? null,
      gain: recipe.gain ?? null,
      saturatedPixelFraction: rendered.saturatedPixelFraction,
      p99Intensity: rendered.p99Intensity,
      source: 'measured',
    },
  };

  const lanes: LaneMaterial[] = recipe.lanes.map((ls, idx) => {
    const cl = polyToRaw(rendered.laneCenterlines[ls.id], frame);
    return {
      id: contentId('lane', { slug: recipe.slug, lane: ls.id }),
      kind: 'lane',
      imageId: image.id,
      index: idx,
      label: ls.label,
      leftBoundary: polyToRaw(rendered.laneBoundaries[ls.id].left, frame),
      rightBoundary: polyToRaw(rendered.laneBoundaries[ls.id].right, frame),
      centerline: cl,
      source: 'auto-detected',
      curvature: ls.curve === 'smile' ? 'smile' : ls.curve === 'frown' ? 'frown' : 'straight',
    };
  });
  const laneIdByLocal = new Map(recipe.lanes.map((ls, i) => [ls.id, lanes[i].id]));

  const bands: BandMaterial[] = [];
  for (const ls of recipe.lanes) {
    for (const bs of ls.bands) {
      if (bs.missing) continue;
      const upCenter = rendered.bandCenters[bs.id];
      if (!upCenter) throw new Error(`配方条带 ${bs.id} 未渲染出中心`);
      const center = toRaw(upCenter, frame);
      const overlapsWith = (bs.overlapWith ?? [])
        .filter((otherLocal) => ls.bands.some((b) => b.id === otherLocal))
        .map((localBandId) => contentId('band', { slug: recipe.slug, band: localBandId }));
      bands.push({
        id: contentId('band', { slug: recipe.slug, band: bs.id }),
        kind: 'band',
        laneId: laneIdByLocal.get(ls.id)!,
        center,
        alongPx: 0,
        halfWidthPx: (bs.sigmaY ?? 5) * 2.2,
        peakIntensity: bs.saturated ? 255 : Math.round((bs.intensity ?? 0.75) * 235 + 28),
        saturated: !!bs.saturated,
        smear: !!bs.smear,
        overlapsWith,
        status: 'candidate',
        source: 'auto-detected',
        ladderNominalId: bs.ladderNominalId,
      });
    }
  }

  const ladderLaneLocal = recipe.lanes.find((l) => l.id === recipe.ladderLaneId)!;
  const ladder: LadderMaterial = {
    id: contentId('lad', { slug: recipe.slug, lane: recipe.ladderLaneId }),
    kind: 'ladder',
    laneId: laneIdByLocal.get(ladderLaneLocal.id)!,
    unit: recipe.ladderUnit,
    nominals,
    source: 'catalog',
    catalogName: recipe.ladderCatalog,
  };

  const bundle: MaterialBundle = { image, lanes, bands, ladder };
  const rawRepresentation = {
    format: 'gel-ruler-workbench.case-pack/v1',
    slug: recipe.slug,
    image: { filename: image.filename, orientationDeg: deg, exposureTimeSec: recipe.exposureTimeSec ?? null, gain: recipe.gain ?? null },
    ladderNominals: recipe.ladderNominals.map((n) => ({ id: n.id, raw: n.raw, missing: !!n.missing })),
  };

  return {
    slug: recipe.slug,
    name: name ?? recipe.slug,
    bundle,
    pngBase64: rendered.png.toString('base64'),
    rawRepresentation,
    diagnostics,
  };
}
