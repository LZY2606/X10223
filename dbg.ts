import { renderGel, baselineSpec } from './src/core/synth.ts';
import { extractLaneProfile, findPeaks, classifyFlags } from './src/core/signal.ts';
const spec = baselineSpec({ gain: 1.35 });
const gel = renderGel(spec);
spec.lanes.forEach((sl, i) => {
  const cl = [{x:sl.x,y:0,frame:'image' as const},{x:sl.x,y:gel.height-1,frame:'image' as const}];
  const prof = extractLaneProfile(gel.pixels, gel.width, gel.height, cl, sl.halfWidth);
  const peaks = findPeaks(prof, { minHeight: 28, resolutionWidth: 16 });
  const flags = classifyFlags(peaks, { saturationGray: 250, tailingRatio: 1.8 });
  console.log('lane', i, peaks.map((p,j)=>({s:p.s.toFixed(1), top:p.rawTop, fwhm:p.fwhm.toFixed(1), cl:p.cluster.length, flag:flags.get(j)})));
});
