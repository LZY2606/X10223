import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderGel } from './gel-render.mjs';
import { GEL_SPECS, LADDER_TABLE } from './gel-specs.mjs';
import { encodePng } from './png-encode.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'cases', 'gel-calibration-workbench');
const imgDir = join(outDir, 'images');
mkdirSync(imgDir, { recursive: true });

function rotateCw90(buf, w, h) {
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[x * h + (h - 1 - y)] = buf[y * w + x];
    }
  }
  return { gray: out, width: h, height: w };
}

const gels = {};
for (const [key, spec] of Object.entries(GEL_SPECS)) {
  let result;
  if (spec.rotateRender90) {
    const base = GEL_SPECS[spec.baseSpec];
    const r0 = renderGel(base);
    const rot = rotateCw90(r0.gray, r0.width, r0.height);
    result = { ...rot, png: encodePng(rot.gray, rot.width, rot.height), lanes: r0.lanes, bands: r0.bands };
  } else {
    result = renderGel(spec);
  }
  writeFileSync(join(imgDir, spec.file), result.png);
  const sha = createHash('sha256').update(result.png).digest('hex');
  gels[key] = { spec, sha, width: result.width, height: result.height, lanes: result.lanes, bands: result.bands };
}

const scenarios = [
  { id: 'rotate-image', gel: 'rotated', title: '旋转图像', rule: '方向材料校正后所有像素证据仍指回原图坐标', impact: { include: ['mw'], exclude: [] } },
  { id: 'curved-lane', gel: 'curved', title: '弯曲泳道（微笑）', rule: 'SMILE_SAME_HEIGHT_NOT_SAME_MW', impact: { include: ['mw', 'lp'], exclude: [] } },
  { id: 'ladder-missing', gel: 'ladderMissing', title: 'ladder 缺带', rule: 'LOCAL_RULER_NEEDS_VALID_REGION', impact: { include: ['lc', 'mw'], exclude: [] } },
  { id: 'saturated-region', gel: 'saturation', title: '饱和区', rule: 'SATURATION_ONLY_CANDIDATE_OR_INTERVAL', impact: { include: ['mw'], exclude: [] } },
  { id: 'overlap-bands', gel: 'overlap', title: '两条带重叠', rule: 'OVERLAP_KEEP_ALL_LEGAL_CANDIDATES', impact: { include: ['mw'], exclude: [] } },
  { id: 'nonmonotonic-ruler', gel: 'nonmonotonic', title: '非单调标尺', rule: 'LOCAL_RULER_NEEDS_VALID_REGION', impact: { include: ['lc'], exclude: [] } },
  { id: 'revision-local-invalidation', gel: 'localInvalid', title: '修订后局部失效', rule: 'LOCAL_RULER_NEEDS_VALID_REGION', impact: { include: ['lc', 'mw'], exclude: [] } }
];

const casePack = {
  id: 'gel-calibration-workbench',
  name: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
  version: '1.0.0',
  domain: 'molecular-biology.gel-electrophoresis',
  unitBasis: { mass: 'bp', migration: 'pixel-arc-length', time: 'unix-ms', coordinateFrame: 'original-image top-left' },
  ladderTable: LADDER_TABLE,
  gels: Object.fromEntries(
    Object.entries(gels).map(([key, g]) => [
      key,
      {
        file: `images/${g.spec.file}`,
        sha256: g.sha,
        width: g.width,
        height: g.height,
        title: g.spec.title,
        exposure: g.spec.exposure,
        orientation: g.spec.orientation,
        nominalOverrides: g.spec.nominalOverrides ?? null,
        dropNominalRows: g.spec.dropNominalRows ?? [],
        lanes: g.lanes.map((l) => ({
          laneIndex: l.index,
          role: l.spec.role,
          label: ['M', 'S1', 'S2', 'S3', 'S4'][l.index],
          width: l.width,
          center: l.center
        })),
        bands: g.bands.map((b) => ({
          laneIndex: b.laneIndex,
          x: Math.round(b.x * 100) / 100,
          y: b.y,
          fwhm: b.fwhm,
          saturated: b.saturated,
          smeared: b.smeared,
          overlap: b.overlap,
          nominalRow: b.nominalRow ?? null
        }))
      }
    ])
  ),
  scenarios
};

writeFileSync(join(outDir, 'case.json'), JSON.stringify(casePack, null, 2));
console.log(`case pack generated: ${Object.keys(gels).length} gels -> ${imgDir}`);
