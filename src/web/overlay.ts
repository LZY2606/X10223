import type { ProjectView } from './types';

/**
 * 在原图 canvas 上叠加：lane 曲线、边界、条带中心、局部标尺有效区域、
 * ladder 点与插值段、拟合残差；点击分子量可回到 ladder 点与插值段。
 */
export interface OverlaySelection {
  kind: 'inference' | 'ladder-band' | 'segment' | 'band';
  id: string;
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  view: ProjectView,
  scale: number,
  selection: OverlaySelection | null,
  onPick: (sel: OverlaySelection) => void,
): ((px: number, py: number) => void) {
  const lanes = view.lanes ?? [];
  const bands = view.bands ?? [];
  const fits = view.analysis?.result.fits ?? [];
  const inferences = view.analysis?.result.inferences ?? [];
  const hitAreas: { x: number; y: number; r: number; sel: OverlaySelection }[] = [];

  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineWidth = 1 / scale;

  // 1) 有效区域（插值段 y 区间，仅 ladder 道）。
  for (const fit of fits) {
    for (const seg of fit.segments) {
      const color =
        seg.status === 'valid'
          ? 'rgba(80,220,140,0.10)'
          : seg.status === 'missing-span'
            ? 'rgba(240,180,60,0.16)'
            : 'rgba(240,80,80,0.18)';
      ctx.fillStyle = color;
      ctx.fillRect(0, seg.yMin, view.image!.width, Math.max(2, seg.yMax - seg.yMin));
    }
  }

  // 2) lane 中心线 + 边界。
  lanes.forEach((lane, li) => {
    const pts = lane.centerline.points;
    ctx.beginPath();
    pts.forEach((p: any, i: number) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = lane.role === 'ladder' ? '#57c7ff' : '#9be7a0';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // 边界
    ctx.strokeStyle = lane.role === 'ladder' ? 'rgba(87,199,255,0.35)' : 'rgba(155,231,160,0.3)';
    ctx.lineWidth = 0.8;
    for (const off of [-lane.halfWidthPx, lane.halfWidthPx]) {
      ctx.beginPath();
      pts.forEach((p: any, i: number) => {
        // 近似：按法线偏移
        const q = offsetNormal(pts, i, off);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
    }
    ctx.fillStyle = lane.role === 'ladder' ? '#57c7ff' : '#9be7a0';
    ctx.font = '10px ui-monospace, monospace';
    const first = pts[0];
    if (first) ctx.fillText(`${lane.label}${lane.provenance?.role === 'manual-revision' ? ' ✎' : ''}`, first.x - 8, first.y - 6);
    void li;
  });

  // 3) ladder 插值段连线（连接相邻 ladder 点）。
  for (const fit of fits) {
    const byId = new Map(bands.map((b: any) => [b.bandId, b]));
    for (const seg of fit.segments) {
      const hi = byId.get(seg.highBandId);
      const lo = byId.get(seg.lowBandId);
      if (!hi || !lo) continue;
      ctx.beginPath();
      ctx.moveTo(hi.center.x, hi.center.y);
      ctx.lineTo(lo.center.x, lo.center.y);
      ctx.strokeStyle =
        seg.status === 'non-monotonic' ? '#ff6b6b' : seg.status === 'missing-span' ? '#f0b43c' : '#57c7ff';
      ctx.setLineDash(seg.status === 'valid' ? [] : [4, 3]);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 残差：ladder 点到全局拟合位置的水平短杠。
    for (const r of fit.residuals) {
      const b = byId.get(r.bandId);
      if (!b) continue;
      ctx.beginPath();
      ctx.moveTo(b.center.x - 14, b.center.y);
      ctx.lineTo(b.center.x - 14, b.center.y + r.residualPx);
      ctx.strokeStyle = Math.abs(r.residualPx) > 3 ? '#ff8c5a' : '#8fa';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      hitAreas.push({ x: b.center.x, y: b.center.y, r: 7, sel: { kind: 'ladder-band', id: b.bandId } });
    }
  }

  // 4) 条带中心。
  bands.forEach((b: any) => {
    const isLadder = lanes.find((l: any) => l.laneId === b.laneId)?.role === 'ladder';
    const selected = selection?.kind === 'band' && selection.id === b.bandId;
    ctx.beginPath();
    ctx.arc(b.center.x, b.center.y, selected ? 6 : 4, 0, Math.PI * 2);
    let color = isLadder ? '#57c7ff' : '#ffffff';
    if (b.saturated) color = '#ff5d5d';
    else if (b.overlapsWith?.length) color = '#ffb347';
    else if (b.tailed) color = '#c79bff';
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = b.provenance?.role === 'manual-revision' ? '#ffe066' : '#000';
    ctx.stroke();
    hitAreas.push({ x: b.center.x, y: b.center.y, r: 7, sel: { kind: 'band', id: b.bandId } });
  });

  // 5) 样本推断：在条带右侧画分子量标签（点击回溯）。
  const infByBand = new Map(inferences.map((i: any) => [i.bandId, i]));
  bands.forEach((b: any) => {
    const inf = infByBand.get(b.bandId);
    if (!inf) return;
    const representative = view.adopted[b.bandId]
      ? inf.candidates.find((c: any) => c.candidateId === view.adopted[b.bandId])
      : inf.candidates[0];
    if (!representative) {
      tag(ctx, b.center.x + 8, b.center.y, '无解', '#ff6b6b');
      return;
    }
    const palette: Record<string, string> = {
      unique: '#9be7a0',
      'candidate-set': '#ffb347',
      interval: '#c79bff',
      coarse: '#f0b43c',
      unresolved: '#ff6b6b',
    };
    tag(ctx, b.center.x + 8, b.center.y, `${representative.bpLabel}${inf.candidates.length > 1 ? ` ·${inf.candidates.length}` : ''}`, palette[inf.status] ?? '#fff');
    hitAreas.push({ x: b.center.x + 24, y: b.center.y, r: 9, sel: { kind: 'inference', id: inf.inferenceId } });
  });

  ctx.restore();

  return (px: number, py: number) => {
    const x = px / scale;
    const y = py / scale;
    for (const h of hitAreas) {
      if (Math.hypot(x - h.x, y - h.y) <= h.r) {
        onPick(h.sel);
        return;
      }
    }
  };
}

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  ctx.font = '10px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 6;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y - 8, w, 13);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 3, y + 2);
}

function offsetNormal(points: any[], i: number, off: number) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const p = points[i];
  return { x: p.x + nx * off, y: p.y + ny * off };
}
