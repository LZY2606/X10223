import { createHash } from 'node:crypto';
import type {
  PixelPoint,
  ImageMaterial,
  LadderLaneMaterial,
  LaneMaterial,
  BandObservation,
  CalibParamsV1,
} from './types.ts';
import { DEFAULT_CALIB_PARAMS_V1 } from './types.ts';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 规范化 JSON：键排序、无空格 —— 等价输入得到稳定摘要/顺序 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function digestOf(...parts: string[]): string {
  return sha256Hex(Buffer.from(parts.join('\n--\n'), 'utf8'));
}

/** 稳定身份：项目内槽位 id，跨导出/删除/导入保持 */
export function slotId(prefix: string, projectId: string, local: string): string {
  return `${prefix}:${projectId}:${local}`;
}

export function eventId(projectId: string, seq: number): string {
  return `evt:${projectId}:${String(seq).padStart(4, '0')}`;
}

export function cloneParams(patch: Partial<CalibParamsV1>): CalibParamsV1 {
  return { ...DEFAULT_CALIB_PARAMS_V1, ...patch };
}

/** 点到折线投影：返回 {s（弧长）, t（横向偏移）, cx,cy（曲线上垂足）} */
export function projectToPolyline(
  px: number,
  py: number,
  points: PixelPoint[],
): { s: number; t: number; cx: number; cy: number; segIndex: number } {
  let best: { s: number; t: number; cx: number; cy: number; segIndex: number } | null = null;
  let bestDist = Infinity;
  let sRun = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-12;
    const u = Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    const cx = a.x + u * dx;
    const cy = a.y + u * dy;
    const ex = px - cx;
    const ey = py - cy;
    const dist2 = ex * ex + ey * ey;
    if (dist2 < bestDist) {
      const segLen = Math.hypot(dx, dy);
      const s = sRun + u * segLen;
      const tx = dx / Math.sqrt(len2);
      const ty = dy / Math.sqrt(len2);
      best = {
        s,
        t: ex * tx + ey * ty,
        cx,
        cy,
        segIndex: i,
      };
      bestDist = dist2;
    }
    sRun += Math.hypot(dx, dy);
  }
  return best ?? { s: 0, t: 0, cx: points[0].x, cy: points[0].y, segIndex: 0 };
}

export function arcLength(points: PixelPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

/** 折线残差：点相对拟合中心线的横向偏移 RMS（px） */
export function polylineResidual(observed: PixelPoint[], fitted: PixelPoint[]): number {
  if (observed.length === 0) return 0;
  let sum = 0;
  for (const p of observed) {
    const proj = projectToPolyline(p.x, p.y, fitted);
    sum += proj.t * proj.t;
  }
  return Math.sqrt(sum / observed.length);
}

/** 刚体旋转像素坐标（顺时针） */
export function rotatePoint(
  p: PixelPoint,
  deg: 0 | 90 | 180 | 270,
  w: number,
  h: number,
): PixelPoint {
  let { x, y } = p;
  if (deg === 90) [x, y] = [h - 1 - y, x];
  else if (deg === 180) [x, y] = [w - 1 - x, h - 1 - y];
  else if (deg === 270) [x, y] = [y, w - 1 - x];
  const frame = deg === 0 ? p.frame : `image-rot${deg}` as PixelPoint['frame'];
  return { x, y, frame };
}

export function transformPixelBuffer(
  pixels: Uint8Array,
  w: number,
  h: number,
  rotate: 0 | 90 | 180 | 270,
  flipH: boolean,
  flipV: boolean,
): { pixels: Uint8Array; width: number; height: number } {
  let cur = pixels;
  let cw = w;
  let ch = h;
  if (rotate === 90 || rotate === 270) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [nx, ny] = rotate === 90 ? [h - 1 - y, x] : [y, w - 1 - x];
        out[ny * h + nx] = cur[y * w + x];
      }
    }
    cur = out;
    cw = h;
    ch = w;
  } else if (rotate === 180) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[(ch - 1 - y) * cw + (cw - 1 - x)] = cur[y * w + x];
    }
    cur = out;
  }
  if (flipH || flipV) {
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = flipH ? cw - 1 - x : x;
        const sy = flipV ? ch - 1 - y : y;
        out[y * cw + x] = cur[sy * cw + sx];
      }
    }
    cur = out;
  }
  return { pixels: cur, width: cw, height: ch };
}

export function sampleMaterialsDigest(m: {
  image: ImageMaterial;
  ladder: LadderLaneMaterial;
  lanes: LaneMaterial[];
  bands: BandObservation[];
}): {
  imagePixels: string;
  orientation: string;
  exposure: string;
  ladderNominals: string;
  laneGeometry: string;
  bandCenters: string;
  overall: string;
} {
  const imagePixels = m.image.pixelsSha256;
  const orientation = sha256Text(canonicalJson(m.image.orientation));
  const exposure = sha256Text(canonicalJson(m.image.exposure));
  const ladderNominals = sha256Text(
    canonicalJson(m.ladder.nominals.map((n) => ({ r: n.rungId, m: n.mw, o: n.ordinal }))),
  );
  const laneGeometry = sha256Text(
    canonicalJson(
      [...m.lanes]
        .sort((a, b) => a.index - b.index)
        .map((l) => ({ id: l.id, c: l.centerline, l: l.leftBoundary, r: l.rightBoundary })),
    ),
  );
  const bandCenters = sha256Text(
    canonicalJson(
      [...m.bands]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((b) => ({ id: b.id, c: b.center, f: b.flag })),
    ),
  );
  return {
    imagePixels,
    orientation,
    exposure,
    ladderNominals,
    laneGeometry,
    bandCenters,
    overall: digestOf(imagePixels, orientation, exposure, ladderNominals, laneGeometry, bandCenters),
  };
}
