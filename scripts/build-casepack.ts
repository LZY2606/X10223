// 生成离线案例包：casepack/{baseline.png, manifest.json, scenarios/*.png}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { sha256Hex } from '../src/shared/digest.js';
import {
  BASELINE_PARAMS, type BandAnnotation, type BandAnnotationMaterial, type ExposureMaterial,
  type ImageMaterial, type LadderSpecMaterial, type LaneCurve, type LaneGeometryMaterial,
  type Material, type OrientationMaterial, type PixelPoint, type Rotation,
} from '../src/shared/types.js';
import { renderGel, straightLane, smilingLane, type RenderBand, type RenderLane } from './gel-render.js';
import { GEL_W, GEL_H, WELL_Y, LANE_LENGTH, HALF_W, LANE_X, LANE_IDS, LADDER_BP, LADDER_S, SAMPLE_BANDS } from './bp-layout.js';
import type { CasePack, ScenarioSpec } from './casepack-schema.js';

const OUT = join(process.cwd(), 'casepack');
mkdirSync(join(OUT, 'scenarios'), { recursive: true });

const now = '2026-09-23T03:40:00+09:00';
function anchor(materialId: string, fieldPath: string, method: 'manual'|'auto'|'declared', file = 'manifest.json', byteOffset = 0): Material extends never ? never : import('../src/shared/types.js').SourceAnchor {
  return { materialId, fieldPath, byteOffset, line: undefined, importedFrom: file, recordedAt: now, method };
}

function ladderBands(smile: boolean, missingAt: number[] = []): RenderBand[] {
  const amp = smile ? 10 : 0;
  return LADDER_S.map((s, idx) => ({ s, w: 7, saturated: false }))
    .filter((_, idx) => !missingAt.includes(LADDER_BP[idx]))
    .map((b) => ({ ...b }))
    .concat(amp ? [] : []);
}

function laneFor(idx: number, opts: { smile?: boolean; missingLadderAt?: number[]; saturate?: Set<string> }): RenderLane {
  const smile = opts.smile ?? false;
  const amp = smile ? 10 : 0;
  let bands: RenderBand[];
  if (idx === 0) {
    bands = LADDER_S.map((s, i) => ({ s, w: 7 }))
      .filter((_, i) => !(opts.missingLadderAt ?? []).includes(LADDER_BP[i]));
  } else {
    bands = (SAMPLE_BANDS[idx] ?? []).map((b) => {
      const id = `${LANE_IDS[idx]}-b${b.s}`;
      return { s: b.s, w: b.tailed ? 13 : b.overlap ? 6 : 7, saturated: b.saturated || opts.saturate?.has(id), brightness: b.tailed ? 120 : 150 };
    });
  }
  if (smile) return smilingLane(LANE_X[idx], WELL_Y, LANE_LENGTH, HALF_W, amp, bands);
  return straightLane(LANE_X[idx], WELL_Y, LANE_LENGTH, HALF_W, bands);
}

function buildPng(opts: { smile?: boolean; missingLadderAt?: number[]; saturateBand?: string } = {}): PNG {
  const sat = opts.saturateBand ? new Set([opts.saturateBand]) : new Set<string>();
  if (opts.saturateBand === '*ladder-some') LADDER_S.forEach((s) => { if (s === 158) sat.add(`lane-L-b${s}`); });
  const lanes = LANE_IDS.map((_, i) => laneFor(i, { smile: opts.smile, missingLadderAt: opts.missingLadderAt, saturate: sat }));
  return renderGel({ width: GEL_W, height: GEL_H, lanes });
}

function rotatePng(src: PNG, rot: Rotation): PNG {
  if (rot === 0) return src;
  const swp = rot === 90 || rot === 270;
  const w2 = swp ? src.height : src.width, h2 = swp ? src.width : src.height;
  const out = new PNG({ width: w2, height: h2 });
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    let qx = x, qy = y, w = src.width, h = src.height;
    if (rot === 90) { qx = h - 1 - y; qy = x; }
    if (rot === 180) { qx = w - 1 - x; qy = h - 1 - y; }
    if (rot === 270) { qx = y; qy = w - 1 - x; }
    const si = (y * src.width + x) * 4, di = (qy * w2 + qx) * 4;
    out.data[di] = src.data[si]; out.data[di+1] = src.data[si+1]; out.data[di+2] = src.data[si+2]; out.data[di+3] = 255;
  }
  return out;
}

function savePng(png: PNG, file: string): { sha: string; bytes: number } {
  const buf = PNG.sync.write(png);
  writeFileSync(join(OUT, file), buf);
  return { sha: sha256Hex(buf), bytes: buf.length };
}

// ---- 基线材料（全部带像素级 provenance） ----
function baselineMaterials(imageSha: string): Material[] {
  const imageId = 'img-baseline';
  const image: ImageMaterial = {
    type: 'source-image', id: imageId, blobSha256: imageSha,
    fileName: 'baseline.png', width: GEL_W, height: GEL_H, grayscaleMax: 255,
    declaredAt: now, provenance: anchor(imageId, '$', 'declared', 'baseline.png', 0),
  };
  const orientation: OrientationMaterial = {
    type: 'capture-orientation', id: 'ori-baseline', imageId,
    rotationDeclared: 0, wellsAtDeclared: 'top',
    provenance: anchor('ori-baseline', 'rotationDeclared', 'declared'),
  };
  const exposure: ExposureMaterial = {
    type: 'exposure', id: 'exp-baseline', imageId,
    exposureSecondsRaw: '1/30', exposureSeconds: 1 / 30,
    gainRaw: 'ISO200', gain: 200, gamma: 2.2,
    provenance: anchor('exp-baseline', 'exposureSecondsRaw', 'declared'),
  };
  const ladder: LadderSpecMaterial = {
    type: 'ladder-spec', id: 'ladder-ds1k', name: 'DS-1000 demo ladder',
    entries: LADDER_BP.map((bp, i) => ({
      ordinal: i + 1, id: `nom-${bp}`, raw: `${bp}bp`, nominalBp: bp, unit: 'bp',
    })),
    provenance: anchor('ladder-ds1k', 'entries', 'declared', 'ladder.csv'),
  };
  // 故意加入一条无法转换的标称（保留原始表示、留在原位置、附诊断，不删除）
  ladder.entries.push({ ordinal: 9, id: 'nom-bad', raw: 'unkn0wn', nominalBp: null, unit: 'bp', unusableReason: '无法解析为 bp 数字' });

  const lanes: LaneCurve[] = LANE_IDS.map((laneId, i) => ({
    laneId, ordinal: i, role: i === 0 ? 'ladder' : 'sample',
    sampleName: i === 0 ? undefined : `Sample ${i}`,
    points: [{ x: LANE_X[i], y: WELL_Y }, { x: LANE_X[i], y: WELL_Y + LANE_LENGTH }],
    halfWidthPx: HALF_W,
    provenance: anchor(laneId, 'points', 'auto', 'lane-detect.json', 100 + i * 40),
  }));
  const geometry: LaneGeometryMaterial = {
    type: 'lane-geometry', id: 'geo-baseline', imageId,
    ladderLaneId: LANE_IDS[0], lanes,
    provenance: anchor('geo-baseline', 'lanes', 'auto', 'lane-detect.json', 0),
  };
  const bands: BandAnnotation[] = [];
  LADDER_S.forEach((s, i) => bands.push({
    id: `${LANE_IDS[0]}-b${LADDER_BP[i]}`, laneId: LANE_IDS[0], ordinal: i + 1,
    center: { x: LANE_X[0], y: WELL_Y + s }, label: `${LADDER_BP[i]}bp`,
    provenance: anchor(`${LANE_IDS[0]}-b${LADDER_BP[i]}`, 'center', 'manual', 'bands.csv', 20 + i * 24),
  }));
  Object.entries(SAMPLE_BANDS).forEach(([laneIdxStr, list]) => {
    const laneIdx = Number(laneIdxStr);
    list.forEach((b, k) => bands.push({
      id: `${LANE_IDS[laneIdx]}-b${b.s}`, laneId: LANE_IDS[laneIdx], ordinal: k + 1,
      center: { x: LANE_X[laneIdx], y: WELL_Y + b.s },
      kindHint: b.saturated ? 'saturated' : b.overlap ? 'overlap' : b.tailed ? 'tailed' : 'normal',
      provenance: anchor(`${LANE_IDS[laneIdx]}-b${b.s}`, 'center', 'manual', 'bands.csv', 200 + laneIdx * 30 + k * 24),
    }));
  });
  const annotation: BandAnnotationMaterial = {
    type: 'band-annotation', id: 'bands-baseline', imageId, bands,
    provenance: anchor('bands-baseline', 'bands', 'manual', 'bands.csv', 0),
  };
  return [image, orientation, exposure, ladder, geometry, annotation];
}

void BASELINE_PARAMS;
export { buildPng, rotatePng, savePng, baselineMaterials, OUT, now };
export type { PixelPoint };
