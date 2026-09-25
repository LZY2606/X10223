import { encodePngGray } from './png.js';

export interface SynthBand {
  s: number;
  massBp: number;
  intensity: number;
  widthPx?: number;
  heightPx?: number;
  saturated?: boolean;
  smear?: boolean;
  smearExtentPx?: number;
}

export interface SynthLane {
  u: number;
  role: 'ladder' | 'sample';
  label: string;
  bands: SynthBand[];
}

export type GelScenario =
  | 'baseline'
  | 'rotated'
  | 'curved-lanes'
  | 'ladder-missing'
  | 'saturation'
  | 'overlap'
  | 'non-monotonic'
  | 'post-revision-failure';

export interface GelSpec {
  scenario: GelScenario;
  width: number;
  height: number;
  laneHalfWidth: number;
  lanes: SynthLane[];
  laneCurveAmpPx: number;
  smileAmpPx: number;
  noise: number;
  missingAtLadderS?: number;
  seed: number;
}

export function rngFactory(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function warpFactory(spec: GelSpec) {
  const L = spec.height - 80;
  const q = (s: number) => Math.sin((Math.PI * s) / L);
  const uMin = Math.min(...spec.lanes.map((l) => l.u));
  const uMax = Math.max(...spec.lanes.map((l) => l.u));
  const h = (u: number) => {
    if (uMax === uMin) return 0;
    const t = (u - uMin) / (uMax - uMin);
    return 1 - 2 * Math.abs(t - 0.5);
  };
  return {
    x(u: number, s: number): number {
      return u + spec.laneCurveAmpPx * q(s);
    },
    y(u: number, s: number): number {
      return 40 + s + spec.smileAmpPx * h(u) * q(s);
    },
  };
}

export function renderGel(spec: GelSpec): { png: Uint8Array; width: number; height: number; truth: Record<string, unknown> } {
  const rng = rngFactory(spec.seed);
  const warp = warpFactory(spec);
  const px = new Uint8Array(spec.width * spec.height);
  px.fill(18);
  for (let i = 0; i < px.length; i++) px[i] = Math.min(60, 14 + Math.floor(rng() * 18));

  const drawBand = (u: number, band: SynthBand) => {
    const w = band.widthPx ?? 14;
    const h = band.smear ? (band.smearExtentPx ?? 46) : (band.heightPx ?? 10);
    const centerS = band.s;
    for (let dy = -h; dy <= h; dy += 1) {
      const sPos = centerS + dy;
      const cx = warp.x(u, sPos);
      const cy = warp.y(u, sPos);
      for (let dx = -spec.laneHalfWidth - 4; dx <= spec.laneHalfWidth + 4; dx += 1) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy);
        if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) continue;
        const fallX = Math.exp(-(dx * dx) / (2 * (w / 2.355) ** 2));
        const fallY = band.smear
          ? Math.exp(-Math.abs(dy) / (h * 0.7))
          : Math.exp(-(dy * dy) / (2 * (h / 2.355) ** 2));
        let v = band.intensity * fallX * fallY;
        if (band.saturated) v = Math.min(255, v + (v > 150 ? 90 : 0));
        const idx = y * spec.width + x;
        px[idx] = Math.max(px[idx]!, Math.min(255, Math.round(v)));
      }
    }
  };

  for (const lane of spec.lanes) {
    for (const band of lane.bands) {
      if (spec.scenario === 'ladder-missing' && lane.role === 'ladder' && band.s === spec.missingAtLadderS) continue;
      drawBand(lane.u, band);
    }
  }

  let png = encodePngGray(spec.width, spec.height, px);
  let width = spec.width;
  let height = spec.height;
  let rotationDeg = 0;
  if (spec.scenario === 'rotated') {
    const r = rotate90CwGray(px, spec.width, spec.height);
    png = r.png;
    width = r.width;
    height = r.height;
    rotationDeg = 90;
  }

  const truth = {
    scenario: spec.scenario,
    canonicalWidth: spec.width,
    canonicalHeight: spec.height,
    renderedWidth: width,
    renderedHeight: height,
    rotationDeg,
    lanes: spec.lanes.map((l) => ({
      u: l.u,
      role: l.role,
      label: l.label,
      bands: l.bands
        .filter((b) => !(spec.scenario === 'ladder-missing' && l.role === 'ladder' && b.s === spec.missingAtLadderS))
        .map((b) => ({
          s: b.s,
          massBp: b.massBp,
          saturated: !!b.saturated,
          smear: !!b.smear,
          x: Math.round(warp.x(l.u, b.s)),
          y: Math.round(warp.y(l.u, b.s)),
        })),
    })),
  };
  return { png, width, height, truth };
}

export function rotate90CwGray(src: Uint8Array, w: number, h: number): { png: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      out[ny * h + nx] = src[y * w + x]!;
    }
  }
  return { png: encodePngGray(h, w, out), width: h, height: w };
}

export const DEFAULT_LADDER_MASSES = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000];

export function makeLadderBands(
  masses: number[],
  opts: { sTop?: number; sBottom?: number; intensity?: number; saturated?: number[]; smear?: number[]; missing?: number } = {},
): SynthBand[] {
  const sTop = opts.sTop ?? 40;
  const sBottom = opts.sBottom ?? 520;
  const minLog = Math.log(masses[0]!);
  const maxLog = Math.log(masses[masses.length - 1]!);
  return masses.map((massBp) => {
    const t = (Math.log(massBp) - minLog) / (maxLog - minLog);
    return {
      s: Math.round(sTop + t * (sBottom - sTop)),
      massBp,
      intensity: opts.intensity ?? 205,
      saturated: opts.saturated?.includes(massBp),
      smear: opts.smear?.includes(massBp),
    };
  });
}
