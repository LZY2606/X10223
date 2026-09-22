import { api } from './api-client.js';
import { loadProject, loadMaterials, loadBranch, allBands, type UiState } from './state.js';
import { drawScene } from './render-canvas.js';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const canvas = $('#gel') as HTMLCanvasElement;
const ctx2d = canvas.getContext('2d')!;

let state = {} as UiState & { image: HTMLImageElement; highlight: any; rotation: number };
state.highlight = {};

async function boot() {
  const project = await loadProject();
  state.project = project.project;
  state.branches = project.branches;
  state.materials = await loadMaterials();
  $('#project-name').textContent = ` · ${state.project.name} · ${state.project.casePackVersion}`;
  renderBranchList();
  await selectBranch('br-main');
  wireToolbar();
}

function renderBranchList() {
  const el = $('#branch-list');
  el.innerHTML = '';
  for (const b of state.branches) {
    const div = document.createElement('div');
    div.className = 'branch' + (b.id === state.currentBranchId ? ' active' : '');
    div.innerHTML = `<div>${b.name}<code class="muted" style="float:right">${b.id}</code></div><div class="sub">${b.purpose}</div>`;
    div.onclick = () => selectBranch(b.id);
    el.appendChild(div);
  }
}

async function selectBranch(branchId: string, seq?: number) {
  state.currentBranchId = branchId;
  state.uptoSeq = seq;
  state.view = await loadBranch(branchId, seq);
  renderBranchList();
  renderTimeline();
  await loadImageAndDraw();
  renderBasis();
  renderBandTable();
  $('#inspector').className = 'inspector muted';
  $('#inspector').textContent = '点击任一分子量或 ladder 点查看来源、插值段与拟合残差。';
}

async function loadImageAndDraw() {
  const sha = state.view.compute.imageSha256;
  const url = `/api/image/${sha}?t=${state.currentBranchId}`;
  state.image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  const rot = rotationFromEvents();
  state.rotation = rot;
  redraw();
}

function rotationFromEvents(): 0 | 90 | 180 | 270 {
  const ev = [...state.view.events].reverse().find((e) => e.type === 'orientation-confirmed');
  return (ev?.payload as any)?.rotationApplied ?? 0;
}

function redraw() {
  const imgMat = state.materials.find((m: any) => m.type === 'source-image');
  drawScene(ctx2d, state.image, state.view.compute, allBands(state.materials), state.rotation as 0|90|180|270,
    { width: imgMat.width, height: imgMat.height },
    {
      showImage: ($('#tg-image') as HTMLInputElement).checked,
      showLanes: ($('#tg-lanes') as HTMLInputElement).checked,
      showBands: ($('#tg-bands') as HTMLInputElement).checked,
      showProfile: ($('#tg-profile') as HTMLInputElement).checked,
      showResidual: ($('#tg-residual') as HTMLInputElement).checked,
      showValid: ($('#tg-valid') as HTMLInputElement).checked,
      scale: 1.6,
    }, state.highlight);
}

function renderTimeline() {
  const el = $('#timeline');
  el.innerHTML = '';
  for (const e of state.view.events) {
    const div = document.createElement('div');
    div.className = 'ev' + (state.uptoSeq === e.seq ? ' active' : '');
    const payload = summarizePayload(e.type, e.payload);
    div.innerHTML = `<span class="seq">#${e.seq}</span>${eventLabel(e.type)}<div class="sub muted">${payload}</div>`;
    div.onclick = () => selectBranch(state.currentBranchId, e.seq);
    el.appendChild(div);
  }
  const head = document.createElement('div');
  head.className = 'ev' + (state.uptoSeq === undefined ? ' active' : '');
  head.innerHTML = `<span class="seq">HEAD</span>最新决定`;
  head.onclick = () => selectBranch(state.currentBranchId, undefined);
  el.appendChild(head);
}

function eventLabel(t: string) {
  const map: Record<string, string> = {
    'materials-imported': '初始导入（像素级来源）',
    'orientation-confirmed': '核对拍摄方向',
    'param-revision': '参数修订',
    'source-patch': '只改一个直接来源',
    'band-decision': '人工接受/否定',
    'branch-created': '创建分支',
    'project-created': '项目创建',
  };
  return map[t] ?? t;
}
function summarizePayload(t: string, p: any) {
  if (t === 'orientation-confirmed') return `rotationApplied=${p.rotationApplied}°，井=${p.wellsAt}`;
  if (t === 'param-revision') return `${p.fromVersion} → ${p.toVersion}：${p.reason}`;
  if (t === 'source-patch') return `${p.target} · ${p.summary ?? ''}`;
  if (t === 'band-decision') return `${p.bandId}：${p.decision.kind} ${p.decision.bp ?? p.decision.reason ?? ''}`;
  if (t === 'materials-imported') return `${p.materialIds.length} 份不可变材料，来源=${p.importFileName}`;
  return JSON.stringify(p).slice(0, 80);
}

export { boot, selectBranch, redraw, state, ctx2d, canvas };

import { statusTag } from './state.js';

function renderBasis() {
  const c = state.view.compute;
  const imgMat = state.materials.find((m: any) => m.type === 'source-image');
  const ori = state.materials.find((m: any) => m.type === 'capture-orientation');
  const exp = state.materials.find((m: any) => m.type === 'exposure');
  const cal = c.calibration;
  const el = $('#basis');
  const row = (k: string, v: string) => `<div class="kv"><span class="k">${k}</span><span>${v}</span></div>`;
  let html = row('图像', `${imgMat.width}×${imgMat.height}px · sha ${c.imageSha256.slice(0, 14)}…`);
  html += row('拍摄方向', `声明 ${ori.rotationDeclared}°；当前确认旋转 ${state.rotation}°`);
  html += row('曝光基准', `${exp.exposureSecondsRaw}s（规范化 ${exp.exposureSeconds}s）· gain ${exp.gainRaw} · γ ${exp.gamma}`);
  html += row('坐标基准', '像素原点(0,0)=左上；迁移距离 s=沿 lane 曲线弧长 (px-arc)');
  html += row('分子量单位', 'bp（ladder 标称，保留原始字符串）');
  if (cal?.segments?.length) {
    html += row('有效区间', `${cal.validRegion.sMin.toFixed(1)} .. ${cal.validRegion.sMax.toFixed(1)} px-arc`);
    html += row('插值段', `${cal.segments.length} 段（log-bp 分段线性，点击分子量定位）`);
  } else {
    html += row('有效区间', '<span class="diag bad">无（标尺非单调或缺锚点）</span>');
  }
  html += row('参数版本', `${c.paramsVersion}`);
  const allDiag = c.diagnostics;
  if (allDiag.length) {
    html += '<div class="diag bad">失效/候选原因：<ul style="margin:4px 0 0 16px;padding:0">'
      + [...new Set(allDiag.map((d: any) => d.code))].map((code) => `<li>${code}</li>`).join('') + '</ul></div>';
  }
  el.innerHTML = html;
}

function renderBandTable() {
  const c = state.view.compute;
  const el = $('#band-table');
  if (!c.bandResults.length) { el.innerHTML = '<div class="muted">无 sample 道推断（可能标尺语义无解）。</div>'; return; }
  let html = '<table><tr><th>band 身份</th><th>lane</th><th>s(px-arc)</th><th>推断 bp</th><th>自动候选 Δ</th><th>状态</th></tr>';
  for (const r of c.bandResults) {
    const bp = r.candidates.map((cd: any) => cd.bp === null ? '<span class="diag bad">超界</span>'
      : `${cd.bp}${cd.bpRange ? ` (${cd.bpRange.low}–${cd.bpRange.high})` : ''}${cd.kind !== 'unique' ? ` <span class="diag">${cd.kind}</span>` : ''}`).join('<br>') || '<span class="diag bad">—</span>';
    const auto = r.autoMatched ? `${r.autoMatched.bp ?? '超界'} (Δ${r.autoMatched.deltaBpVsManual ?? '—'})` : '—';
    html += `<tr class="bandrow" data-band="${r.bandId}">
      <td><code>${r.bandId}</code></td><td>${r.laneId}</td><td>${r.s.toFixed(1)}</td>
      <td>${bp}</td><td>${auto}</td>
      <td><span class="tag ${statusTag(r.status)}">${r.status}</span></td></tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
  el.querySelectorAll('.bandrow').forEach((tr) => tr.addEventListener('click', () => inspectBand((tr as HTMLElement).dataset.band!)));
}

function findBandResult(bandId: string) {
  return state.view.compute.bandResults.find((r: any) => r.bandId === bandId);
}

function inspectBand(bandId: string) {
  const r = findBandResult(bandId);
  const bandMat = state.materials.find((m: any) => m.type === 'band-annotation');
  const band = bandMat.bands.find((b: any) => b.id === bandId);
  const cand = r?.candidates?.find((c: any) => c.segmentId) ?? r?.candidates?.[0];
  state.highlight = { bands: [bandId], segments: cand?.segmentId ? [cand.segmentId] : [] };
  redraw();
  const decisions = state.view.events.filter((e) => e.type === 'band-decision' && (e.payload as any).bandId === bandId);
  const seg = cand?.segmentId ? state.view.compute.calibration?.segments.find((s: any) => s.id === cand.segmentId) : null;
  const prov = band.provenance;
  $('#inspector').className = 'inspector';
  $('#inspector').innerHTML = `
    <div class="kv"><span class="k">稳定身份</span><code>${bandId}</code></div>
    <div class="kv"><span class="k">像素来源</span>${prov.importedFrom} · ${prov.fieldPath} · 字节${prov.byteOffset ?? 0} · ${prov.method}</div>
    <div class="kv"><span class="k">人工中心</span>(${band.center.x}, ${band.center.y}) px → s=${r?.s.toFixed(1)} px-arc</div>
    <div class="kv"><span class="k">插值段</span>${seg
      ? `<span class="pill clickable" data-seg="${seg.id}">${seg.id}<br>${seg.bpFrom}bp@${seg.sFrom.toFixed(0)} → ${seg.bpTo}bp@${seg.sTo.toFixed(0)}</span>`
      : '<span class="diag bad">无（超出有效区或标尺无解）</span>'}</div>
    <div class="kv"><span class="k">候选</span>${(r?.candidates ?? []).map((cd: any) =>
      `<span class="pill ${cd.kind === 'unique' ? '' : 'sat'} clickable" data-cand="${cd.candidateId}">${cd.kind}: ${cd.bp ?? 'null'}bp</span>`).join('') || '<span class="diag bad">无合法候选</span>'}</div>
    <div class="kv"><span class="k">诊断</span>${(r?.diagnostics ?? []).map((d: any) => `<div class="diag ${d.code.includes('NO_SOLUTION') ? 'bad' : ''}">${d.code}: ${d.message}</div>`).join('') || '无'}</div>
    <div class="kv"><span class="k">决定历史</span>${decisions.map((d: any) => `<div>#${d.seq} ${d.payload.decision.kind} ${d.payload.decision.bp ?? ''} <span class="muted">${d.payload.reason}</span></div>`).join('') || '尚无决定'}</div>
    <div>
      <button class="small" data-act="accept">接受为…</button>
      <button class="small" data-act="range">标为区间</button>
      <button class="small" data-act="reject">否定</button>
      <button class="small" data-act="params">调整参数并新事件</button>
    </div>`;
  $('#inspector').querySelectorAll<HTMLElement>('[data-act]').forEach((btn) => btn.onclick = () => decide(bandId, btn.dataset.act!));
  $('#inspector').querySelectorAll<HTMLElement>('[data-seg]').forEach((el2) => el2.onclick = () => inspectSegment(el2.dataset.seg!));
}

function inspectSegment(segId: string) {
  const cal = state.view.compute.calibration;
  const seg = cal.segments.find((s: any) => s.id === segId);
  state.highlight = { segments: [segId], anchors: [seg.fromAnchorOrdinal, seg.toAnchorOrdinal] };
  redraw();
  const ladder = state.materials.find((m: any) => m.type === 'ladder-spec');
  const aFrom = ladder.entries.find((e: any) => e.ordinal === seg.fromAnchorOrdinal);
  const aTo = ladder.entries.find((e: any) => e.ordinal === seg.toAnchorOrdinal);
  void aTo;
  $('#inspector').className = 'inspector';
  $('#inspector').innerHTML = `
    <div class="kv"><span class="k">插值段身份</span><code>${segId}</code></div>
    <div class="kv"><span class="k">区间</span>${seg.bpFrom}bp @ s=${seg.sFrom.toFixed(1)} → ${seg.bpTo}bp @ s=${seg.sTo.toFixed(1)}</div>
    <div class="kv"><span class="k">两端锚点</span><span class="pill">ordinal ${seg.fromAnchorOrdinal} (${aFrom.raw})</span> ⇒ <span class="pill">ordinal ${seg.toAnchorOrdinal}</span></div>
    <div class="kv"><span class="k">跨缺带</span>${seg.skippedNominalOrdinals.length ? seg.skippedNominalOrdinals.join(',') : '无'}</div>
    <div class="kv"><span class="k">公式</span>log(bp) 对 s 线性；仅在该段 [sFrom,sTo] 有效</div>
    <div class="muted">点击 ladder 圆点可查看拟合残差（全局 log 线仅用于显示残差，不参与推断）。</div>`;
}

async function decide(bandId: string, act: string) {
  const branchId = state.currentBranchId;
  let payload: any;
  if (act === 'accept') {
    const bp = Number(prompt('接受的分子量 bp（自动/人工核对后）：', '480'));
    if (!bp) return;
    payload = { bandId, laneId: bandId.split('-b')[0], decision: { kind: 'accept', bp }, reason: '审阅接受（界面新事件）' };
  } else if (act === 'range') {
    const lo = Number(prompt('区间下限 bp', '420')); const hi = Number(prompt('区间上限 bp', '540'));
    if (!lo || !hi) return;
    payload = { bandId, laneId: bandId.split('-b')[0], decision: { kind: 'range', bpLow: lo, bpHigh: hi }, reason: '无法唯一决定，保留区间' };
  } else if (act === 'reject') {
    payload = { bandId, laneId: bandId.split('-b')[0], decision: { kind: 'reject', reason: '证据不足/超出有效区' }, reason: '审阅否定' };
  } else {
    await api('/api/event', { method: 'POST', body: JSON.stringify({ branchId, type: 'param-revision', payload: {
      fromVersion: state.view.compute.paramsVersion, toVersion: 'params-002-saturation-200', reason: '检查器中调整饱和阈值' } }) });
    await selectBranch(branchId);
    return;
  }
  await api('/api/event', { method: 'POST', body: JSON.stringify({ branchId, type: 'band-decision', payload }) });
  await selectBranch(branchId);
}

function wireToolbar() {
  ['tg-image', 'tg-lanes', 'tg-bands', 'tg-profile', 'tg-residual', 'tg-valid'].forEach((id) => {
    document.getElementById(id)!.addEventListener('change', redraw);
  });
  $('#btn-export').addEventListener('click', async () => {
    const res = await fetch('/api/export');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gel-workbench-export.json';
    a.click();
  });
  $('#file-import').addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    if (!input.files?.[0]) return;
    const text = await input.files[0].text();
    const r = await fetch('/api/import', { method: 'POST', body: text });
    const body = await r.json();
    if (!r.ok) { alert(`导入失败：${body.code}\n` + (body.diagnostics ?? []).map((d: any) => `${d.code} ${d.path ?? ''} ${d.message}`).join('\n')); return; }
    alert(`导入成功：${body.branches} 分支 / ${body.events} 事件（身份与顺序保持）`);
    location.reload();
  });
  $('#btn-halfwrite').addEventListener('click', async () => {
    await api('/api/simulate-halfwrite', { method: 'POST' });
    alert('已制造半写（stage=1 未完成）。可点“半写恢复”或重启服务验证自动回滚。');
  });
  $('#btn-recover').addEventListener('click', async () => {
    const r = await api('/api/recover', { method: 'POST' }) as any;
    alert(`恢复完成，回滚 ${r.recovered.length} 个未完成操作`);
  });
  $('#btn-reset').addEventListener('click', async () => {
    await api('/api/reset', { method: 'POST' });
    location.reload();
  });
  $('#btn-fork').addEventListener('click', async () => {
    const head = state.view.branch;
    const upto = state.view.events.find((e) => e.seq === (state.uptoSeq ?? state.view.events[state.view.events.length - 1].seq))!;
    const name = prompt('新分支名称', '审阅分叉 ' + new Date().toISOString().slice(11, 19));
    if (!name) return;
    const newId = 'br-user-' + Math.random().toString(36).slice(2, 8);
    await api('/api/fork', { method: 'POST', body: JSON.stringify({
      newBranchId: newId, name, purpose: '界面分叉', sourceBranchId: head.id, uptoEventId: upto.id }) });
    await boot();
    await selectBranch(newId);
  });

  // 点击图中分子量/ladder 点 -> 回到 ladder 点与插值段
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const x = (ev.clientX - rect.left) * (scaleX / 1.6);
    const y = (ev.clientY - rect.top) * (scaleX / 1.6);
    hitTest(x, y);
  });
}

function hitTest(x: number, y: number) {
  const c = state.view.compute;
  const cal = c.calibration;
  // 优先 ladder 锚点
  if (cal?.anchors) {
    const lp = c.laneViewPoints[cal.ladderLaneId];
    for (const a of cal.anchors) {
      const p = approxPoint(lp, a.s);
      if (p && Math.hypot(p.x - x, p.y - y) < 8) {
        inspectAnchor(a.ordinal);
        return;
      }
    }
  }
  // 条带中心
  for (const b of allBands(state.materials)) {
    const p = rotateForHit(b.center);
    if (Math.hypot(p.x - x, p.y - y) < 8) { inspectBand(b.id); return; }
  }
}

function rotateForHit(p: { x: number; y: number }) {
  const imgMat = state.materials.find((m: any) => m.type === 'source-image');
  const w = imgMat.width, h = imgMat.height;
  const r = state.rotation;
  if (r === 90) return { x: h - 1 - p.y, y: p.x };
  if (r === 180) return { x: w - 1 - p.x, y: h - 1 - p.y };
  if (r === 270) return { x: p.y, y: w - 1 - p.x };
  return { ...p };
}

function approxPoint(pts: { x: number; y: number }[], s: number) {
  // 与 render-canvas 同样的分数换算（s/total）
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const f = s / total;
  let acc = 0, target = f * total;
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

function inspectAnchor(ordinal: number) {
  const cal = state.view.compute.calibration;
  const a = cal.anchors.find((x: any) => x.ordinal === ordinal);
  const seg = cal.segments.find((s: any) => s.fromAnchorOrdinal === ordinal || s.toAnchorOrdinal === ordinal);
  state.highlight = { anchors: [ordinal], segments: seg ? [seg.id] : [] };
  redraw();
  const ladder = state.materials.find((m: any) => m.type === 'ladder-spec');
  const entry = ladder.entries.find((e: any) => e.ordinal === ordinal);
  $('#inspector').className = 'inspector';
  $('#inspector').innerHTML = `
    <div class="kv"><span class="k">ladder 标称</span><code>${entry.id}</code> · 原始表示 “${entry.raw}” · ${entry.unit}</div>
    <div class="kv"><span class="k">标称来源</span>${ladder.provenance.importedFrom} · ${ladder.provenance.fieldPath}[${ordinal - 1}] · ${ladder.provenance.method}</div>
    <div class="kv"><span class="k">匹配条带</span>${a.matchedBandId ? `<code>${a.matchedBandId}</code>` : '<span class="diag bad">缺带（无匹配，跨段插值）</span>'}</div>
    <div class="kv"><span class="k">迁移距离</span>s=${a.s} px-arc（沿 ladder lane 弧长）</div>
    <div class="kv"><span class="k">全局 log 拟合残差</span>${(a.residualVsGlobalLogFit * 100).toFixed(2)}%（仅展示）</div>
    <div class="kv"><span class="k">相连插值段</span>${seg ? `<span class="pill clickable" data-seg="${seg.id}">${seg.id}</span>` : '<span class="diag bad">无</span>'}</div>`;
  const segEl = $('#inspector').querySelector<HTMLElement>('[data-seg]');
  if (segEl) segEl.onclick = () => inspectSegment(segEl.dataset.seg!);
}

boot().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#ff6b6b;padding:10px">${String(err.stack ?? err)}</pre>`);
});
