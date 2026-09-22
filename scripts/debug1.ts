import { buildBranchDefs } from '../src/core/casepack-variants';
import { generateGel } from '../src/core/gelgen';
import { PARAMS_V1 } from '../src/core/params';
import { detectBands } from '../src/core/detector';
import { straightCenterline } from '../src/core/engine';
const def = buildBranchDefs()[0];
const { image } = generateGel(def.variant);
for (let i = 0; i < 8; i++) {
  const x = [90,220,350,480,610,740,870,1000][i];
  const cl = straightCenterline({ width: image.width, height: image.height } as any, x);
  const d = detectBands(image, 'L'+i, cl, 33, PARAMS_V1);
  console.log(i, d.bands.map(b=>Math.round(b.sPx)+':'+b.flag+':'+b.peakIntensity).join(' '), d.diagnostics.map(x=>x.code).join(','));
}
