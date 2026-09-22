import { freshStore, branchView } from './tests/helpers.ts';
const store = freshStore();
for (const id of ['br-main','br-rotated','br-curved','br-missing','br-saturated','br-overlap','br-nonmono','br-local-invalidation','br-conflict']) {
  const v = branchView(store, id);
  const diag = [...new Set(v.nodes.flatMap(n=>n.diagnostics.map(d=>d.code)))];
  console.log(id.padEnd(22), 'nodes=', v.nodes.length, 'bands=', v.bandResults.length,
    'mono=', v.calibration?.monotonic, 'segs=', v.calibration?.segments.length,
    'valid=', v.calibration && (v.calibration.validRegion.sMin).toFixed?.(0),
    'diag=', diag.join(','));
  for (const r of v.bandResults.slice(0,3)) console.log('   ', r.bandId, r.status, JSON.stringify(r.candidates.map(c=>[c.kind,c.bp,c.bpRange])));
}
