import { buildGelCase } from './src/core/caseFactory.js';
import { detectBandsAlongLane, DEFAULT_DETECTION_PARAMETERS } from './src/core/detection.js';
for (const [name, opt] of [['base', {}], ['overlap', {overlap:true}], ['sat', {saturated:true}], ['tail', {tailing:true}]] as const) {
  const b = buildGelCase(opt);
  const bands = detectBandsAlongLane(b.raster, b.lanes[4]!, DEFAULT_DETECTION_PARAMETERS, b.blobId);
  console.log(name, bands.length, bands.map(x=>`${Math.round(x.fit.mu)}/${x.fit.sigma.toFixed(1)}${x.overlapWith.length?'*':''}${x.exposure==='saturated'?'S':''}${x.tailing!=='none'?'T':''}`).join(' '));
}
