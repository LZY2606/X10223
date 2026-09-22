import type { ApiCompute } from './api-client.js';

export interface RenderOpts {
  showImage: boolean; showLanes: boolean; showBands: boolean;
  showProfile: boolean; showResidual: boolean; showValid: boolean;
  scale: number;
}

export function drawScene(
  ctx2d: CanvasRenderingContext2D,
  img: HTMLImageElement,
  compute: ApiCompute,
  bands: Array<{ id: string; laneId: string; center: { x: number; y: number }; kindHint?: string; label?: string }>,
  rotation: 0 | 90 | 180 | 270,
  origSize: { width: number; height: number },
  opts: RenderOpts,
  highlight: { segments?: string[]; bands?: string[]; anchors?: number[] } = {},
) {
  const { width, height } = compute.rotatedSize;
  ctx2d.canvas.width = width * opts.scale;
  ctx2d.canvas.height = height * opts.scale;
  ctx2d.setTransform(opts.scale, 0, 0, opts.scale, 0, 0);
  ctx2d.clearRect(0, 0, width, height);
  if (opts.showImage) ctx2d.drawImage(img, 0, 0, width, height);

  // 有效区域：在 ladder 道上画 sMin..sMax 半透明绿带
  const cal = compute.calibration;
  if (opts.showValid && cal?.segments?.length) {
    const lp = compute.laneViewPoints[cal.ladderLaneId];
    if (lp) {
      ctx2d.strokeStyle = 'rgba(87,209,138,.35)';
      ctx2d.lineWidth = 26; ctx2d.beginPath();
      strokeArcRange(ctx2d, lp, cal.validRegion.sMin, cal.validRegion.sMax);
      ctx2d.stroke();
      ctx2d.fillStyle = 'rgba(87,209,138,.85)';
      ctx2d.font = '9px sans-serif';
      const a = pointAtFraction(lp, cal.validRegion.sMin / arcTotal(lp));
      const b = pointAtFraction(lp, cal.validRegion.sMax / arcTotal(lp));
      ctx2d.fillText(`有效区 ${cal.validRegion.sMin.toFixed(0)}..${cal.validRegion.sMax.toFixed(0)} ${cal.validRegion.unit}`, 4, a.y - 6);
      void b;
    }
  }

  // lane 曲线
  if (opts.showLanes) {
    for (const [laneId, pts] of Object.entries(compute.laneViewPoints)) {
      ctx2d.strokeStyle = laneId === cal?.ladderLaneId ? 'rgba(92,200,255,.9)' : 'rgba(92,200,255,.45)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      pts.forEach((p, i) => i ? ctx2d.lineTo(p.x, p.y) : ctx2d.moveTo(p.x, p.y));
      ctx2d.stroke();
    }
  }

  // 条带轮廓（取 ladder 道 profile，横向缩放叠加在 ladder 左侧）
  if (opts.showProfile) {
    for (const [laneId, prof] of Object.entries(compute.profiles)) {
      const pts = compute.laneViewPoints[laneId];
      if (!pts || !prof.length) continue;
      ctx2d.strokeStyle = laneId === cal?.ladderLaneId ? 'rgba(255,180,84,.9)' : 'rgba(255,180,84,.35)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      prof.forEach((sample, i) => {
        const p = pointAtFraction(pts, sample.s / arcTotal(pts));
        const x = p.x - 18 - (255 - sample.intensity) * 0.12;
        if (i === 0) ctx2d.moveTo(x, p.y); else ctx2d.lineTo(x, p.y);
        if (sample.saturated) { ctx2d.fillStyle = 'rgba(255,107,107,.9)'; ctx2d.fillRect(p.x - 14, p.y - 1, 3, 2); }
      });
      ctx2d.stroke();
    }
  }

  // ladder 锚点与残差
  if (cal?.anchors) {
    const lp = compute.laneViewPoints[cal.ladderLaneId];
    cal.anchors.forEach((a: any) => {
      if (!lp) return;
      const p = pointAtFraction(lp, a.s / arcTotal(lp));
      const hl = highlight.anchors?.includes(a.ordinal);
      ctx2d.fillStyle = hl ? '#ffd166' : (a.matchedBandId ? '#5cc8ff' : '#ff6b6b');
      ctx2d.beginPath(); ctx2d.arc(p.x, p.y, hl ? 5 : 3.5, 0, Math.PI * 2); ctx2d.fill();
      ctx2d.fillStyle = '#9fb4cc'; ctx2d.font = '9px sans-serif';
      ctx2d.fillText(`${a.bp}bp`, p.x + 6, p.y + 3);
      if (opts.showResidual) {
        const w = Math.min(26, Math.abs(a.residualVsGlobalLogFit) * 400);
        ctx2d.fillStyle = Math.abs(a.residualVsGlobalLogFit) > 0.05 ? '#ffb454' : '#3a5066';
        ctx2d.fillRect(p.x - 30, p.y - 1.5, w, 3);
      }
    });
    // 插值段高亮
    if (highlight.segments && lp) {
      for (const seg of cal.segments) {
        if (!highlight.segments.includes(seg.id)) continue;
        ctx2d.strokeStyle = 'rgba(255,209,102,.95)';
        ctx2d.lineWidth = 3;
        ctx2d.beginPath(); strokeArcRange(ctx2d, lp, seg.sFrom, seg.sTo); ctx2d.stroke();
      }
    }
  }

  // 条带中心（人工来源），旋转后位置
  if (opts.showBands) {
    for (const b of bands) {
      const p = rotPt(b.center, rotation, origSize.width, origSize.height);
      const hl = highlight.bands?.includes(b.id);
      let color = '#57d18a';
      if (b.kindHint === 'saturated') color = '#ffb454';
      if (b.kindHint === 'overlap') color = '#c792ea';
      if (b.kindHint === 'tailed') color = '#8be9fd';
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = hl ? 2.5 : 1.2;
      ctx2d.strokeRect(p.x - 5, p.y - 5, 10, 10);
      if (hl) { ctx2d.strokeStyle = '#ffd166'; ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx2d.stroke(); }
    }
  }
}

function rotPt(p: { x: number; y: number }, rot: number, w: number, h: number) {
  if (rot === 90) return { x: h - 1 - p.y, y: p.x };
  if (rot === 180) return { x: w - 1 - p.x, y: h - 1 - p.y };
  if (rot === 270) return { x: p.y, y: w - 1 - p.x };
  return { ...p };
}

function arcTotal(pts: { x: number; y: number }[]) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return t;
}
function pointAtFraction(pts: { x: number; y: number }[], f: number) {
  const total = arcTotal(pts);
  const target = Math.max(0, Math.min(total, f * total));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= target) {
      const t = (target - acc) / (seg || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}
function strokeArcRange(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], sFrom: number, sTo: number) {
  const total = arcTotal(pts);
  const steps = 24;
  for (let k = 0; k <= steps; k++) {
    const s = sFrom + ((sTo - sFrom) * k) / steps;
    const p = pointAtFraction(pts, s / total);
    if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
}
