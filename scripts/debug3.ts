import { buildBranchDefs } from '../src/core/casepack-variants';
import { generateGel } from '../src/core/gelgen';
import { PARAMS_V1 } from '../src/core/params';
import { laneProfile } from '../src/core/detector';
import { straightCenterline } from '../src/core/engine';
const def = buildBranchDefs()[0];
const { image } = generateGel(def.variant);
for (const [lane,x,probe] of [[1,220,[100,189,261,321]],[6,870,[119,179]]] as any) {
  const cl = straightCenterline({ width: image.width, height: image.height } as any, x);
  const p = laneProfile(image, cl, 13, PARAMS_V1);
  for (const s of probe) {
    console.log('lane', lane, 's', s, p.slice(s-2, s+3).map(q=>Math.round(q.intensity)).join(','));
  }
}
