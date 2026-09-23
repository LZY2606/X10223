import { mkdirSync, writeFileSync } from 'node:fs';
import { buildCasePack } from '../src/core/casePack.js';
import { parseBundle, verifyReplayDeterminism } from '../src/core/casePack.js';
import { replay } from '../src/core/replay.js';
import { toGray, decodePng } from '../src/core/image.js';

const artifacts = buildCasePack();
mkdirSync('casepacks', { recursive: true });
const json = JSON.stringify(artifacts.bundle, null, 1);
writeFileSync('casepacks/gel-case-001.gwbundle', json);
const reparsed = parseBundle(json);
verifyReplayDeterminism(reparsed);

const mainEvents = artifacts.bundle.events.filter((e) => e.branch === 'br_main').sort((a, b) => a.seq - b.seq);
const raster = toGray(decodePng(artifacts.built.png));
const view = replay('br_main', mainEvents, { raster }).view;
console.log('branches:', artifacts.bundle.manifest.branchCount);
console.log('events:', artifacts.bundle.manifest.eventCount, 'blobs:', artifacts.bundle.manifest.blobCount);
console.log('lanes:', view.lanes.length, 'bands:', view.bands.length, 'rungs:', view.ladderRungs.length);
console.log('rulers segments:', view.rulers[0]?.segments.length, 'valid:', view.rulers[0]?.segments.filter((s) => s.valid).length);
console.log('mw results:', view.molecularWeights.length);
for (const [key, id] of Object.entries(artifacts.branchIds)) {
  if (key === 'main') continue;
  const events = artifacts.bundle.events.filter((e) => e.branch === id).sort((a, b) => a.seq - b.seq);
  const imageEvent = events.find((e) => e.kind === 'image-imported');
  const blobId = (imageEvent?.payload.image as { blobId: string }).blobId;
  const png = artifacts.blobs.get(blobId)!;
  const r = replay(id, events, { raster: toGray(decodePng(png)) }).view;
  const statuses = r.molecularWeights.map((m) => m.status);
  const diagCodes = [...new Set(r.rulers.flatMap((x) => x.diagnostics.map((d) => d.code)).concat(r.molecularWeights.flatMap((m) => m.diagnostics.map((d) => d.code))))];
  console.log(key.padEnd(16), 'mw=', r.molecularWeights.length, 'statuses=', [...new Set(statuses)], 'diag=', diagCodes.slice(0, 4));
}
