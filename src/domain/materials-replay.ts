import type {
  BandAnnotationMaterial, Event, LadderSpecMaterial, LaneGeometryMaterial,
  Material, OrientationMaterial, ParamSet, Rotation,
} from '../shared/types.js';
import { BASELINE_PARAMS, REVISED_PARAMS } from '../shared/types.js';
import { GEL_W, GEL_H, WELL_Y, LANE_LENGTH, LANE_X, LANE_IDS, HALF_W } from '../../scripts/bp-layout.js';

export interface ReplayState {
  materials: Record<string, Material>;
  rotationApplied: Rotation;
  params: ParamSet;
  // 场景 patch 产生的新材料身份（局部来源变更）
  extraImageSha?: string;
}

export function baseState(materials: Material[]): ReplayState {
  const map: Record<string, Material> = {};
  for (const m of materials) map[m.id] = m;
  return { materials: map, rotationApplied: 0, params: BASELINE_PARAMS };
}

// 在某个事件（含）之后的材料视图；材料本身不可变，事件只引用/新增版本
export function applyEvent(state: ReplayState, event: Event): ReplayState {
  const next: ReplayState = {
    materials: { ...state.materials },
    rotationApplied: state.rotationApplied,
    params: state.params,
    extraImageSha: state.extraImageSha,
  };
  switch (event.type) {
    case 'orientation-confirmed':
      next.rotationApplied = event.payload.rotationApplied;
      break;
    case 'param-revision':
      next.params = event.payload.toVersion === REVISED_PARAMS.version ? REVISED_PARAMS : BASELINE_PARAMS;
      break;
    case 'source-patch': {
      const p = event.payload;
      if (p.target === 'ladder:nominal' && p.newLadder) {
        next.materials = replaceLadder(next.materials, p.newLadder);
      }
      if (p.target === 'lanes:curves' && p.newGeometry) {
        next.materials = replaceGeometry(next.materials, p.newGeometry);
      }
      if (p.target === 'band:center' && p.newBandCenter) {
        next.materials = replaceBand(next.materials, p.newBandCenter.bandId, p.newBandCenter.center);
      }
      if (p.target === 'image:pixels' && p.imageSha256) {
        next.extraImageSha = p.imageSha256;
      }
      if (p.rotationApplied !== undefined) next.rotationApplied = p.rotationApplied;
      break;
    }
    default:
      break;
  }
  return next;
}

function replaceLadder(map: Record<string, Material>, ladder: LadderSpecMaterial) {
  const out = { ...map };
  for (const k of Object.keys(out)) if (out[k].type === 'ladder-spec') delete out[k];
  out[ladder.id] = ladder;
  return out;
}
function replaceGeometry(map: Record<string, Material>, geo: LaneGeometryMaterial) {
  const out = { ...map };
  for (const k of Object.keys(out)) if (out[k].type === 'lane-geometry') delete out[k];
  out[geo.id] = geo;
  return out;
}
function replaceBand(map: Record<string, Material>, bandId: string, center: { x: number; y: number }) {
  for (const m of Object.values(map)) {
    if (m.type === 'band-annotation') {
      const bm = m as BandAnnotationMaterial;
      const bands = bm.bands.map((b) => (b.id === bandId ? { ...b, center } : b));
      return { ...map, [bm.id]: { ...bm, bands } };
    }
  }
  return map;
}

export { GEL_W, GEL_H, WELL_Y, LANE_LENGTH, LANE_X, LANE_IDS, HALF_W };
