import { api, fmt } from './api';
import type { ProjectView } from './types';
import { drawOverlay, type OverlaySelection } from './overlay';

const state: {
  projects: { projectId: string; name: string }[];
  view: ProjectView | null;
  branch: string;
  at: string | null;
  selection: OverlaySelection | null;
  showProfiles: boolean;
  showResidual: boolean;
} = {
  projects: [],
  view: null,
  branch: 'main',
  at: null,
  selection: null,
  showProfiles: true,
  showResidual: true,
};

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const app = () => $('#app')!;

async function loadProjects() {
  const data = await api<{ projects: { projectId: string; name: string }[] }>('/api/projects');
  state.projects = data.projects;
  const current = state.view?.projectId ?? data.projects[0]?.projectId;
  if (current) await loadProject(current);
  renderChrome();
}

async function loadProject(projectId: string) {
  const q = new URLSearchParams();
  if (state.branch) q.set('branch', state.branch);
  if (state.at) q.set('at', state.at);
  state.view = await api<ProjectView>(`/api/project/${encodeURIComponent(projectId)}?${q}`);
  state.branch = state.view.branchId;
  render();
}

function renderChrome() {
  app().innerHTML = `
    <header class="topbar">
      <div class="brand">🧪 胶道标尺工作台 <span class="sub">电泳条带 · 泳道弯曲 · 分子量校准（离线案例包）</span></div>
      <select id="projectSelect" class="project-select"></select>
      <div class="actions">
        <button id="btnExport" class="btn">导出 .gelpack</button>
        <label class="btn file-btn">导入 .gelpack<input type="file" id="fileImport" accept=".gelpack" hidden /></label>
      </div>
    </header>
    <div id="workspace" class="workspace"></div>
    <div id="toast" class="toast" hidden></div>
  `;
  const sel = $('#projectSelect') as HTMLSelectElement;
  sel.innerHTML = state.projects.map((p) => `<option value="${p.projectId}">${p.name}</option>`).join('');
  sel.value = state.view?.projectId ?? '';
  sel.addEventListener('change', () => {
    state.branch = 'main';
    state.at = null;
    state.selection = null;
    loadProject(sel.value);
  });
  $('#btnExport').addEventListener('click', exportPack);
  ($('#fileImport') as HTMLInputElement).addEventListener('change', importPack);
  render();
}

async function exportPack() {
  if (!state.view) return;
  const r = await fetch(`/api/project/${encodeURIComponent(state.view.projectId)}/export`);
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.view.projectId}.gelpack`;
  a.click();
  toast('已导出（身份/分支/决定历史已打包）');
}

async function importPack(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const r = await fetch('/api/import', { method: 'POST', body: await file.arrayBuffer(), headers: {} });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast(`导入失败：[${err.error}] ${err.message ?? ''}`, true);
      return;
    }
    const data = await r.json();
    toast(`导入成功：${data.projectId}`);
    state.branch = 'main';
    state.at = null;
    await loadProjects();
    await loadProject(data.projectId);
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, true);
  }
}

function toast(msg: string, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${error ? 'error' : ''}`;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 3200);
}

function render() {
  if (!state.view) return;
  const ws = $('#workspace');
  if (!ws) return;
  ws.innerHTML = '';
  ws.appendChild(renderMaterialBar());
  const body = document.createElement('div');
  body.className = 'body-grid';
  body.appendChild(renderCanvasPanel());
  body.appendChild(renderSidePanel());
  ws.appendChild(body);
  drawCanvas();
}

function renderMaterialBar(): HTMLElement {
  const v = state.view!;
  const bar = document.createElement('div');
  bar.className = 'material-bar';
  const img = v.image;
  bar.innerHTML = `
    <div class="mat-group">
      <div class="mat-title">L0 不可变材料（像素级来源）</div>
      <div class="mat-items">
        <span class="chip">原图 <code>${img?.origin.filename ?? '—'}</code></span>
        <span class="chip">尺寸 ${img?.width}×${img?.height} px（原图像素坐标）</span>
        <span class="chip ${img?.orientation.declared === 'up' ? '' : 'warn'}">拍摄方向 ${img?.orientation.declared}（${img?.orientation.source}）</span>
        <span class="chip">曝光 ${img?.exposure.raw} → ${img?.exposure.normalized.seconds ?? '无法换算'} s</span>
        <span class="chip">sha256 <code title="${img?.origin.sha256}">${img?.origin.sha256.slice(0, 12)}…</code></span>
        <span class="chip">ladder ${v.ladder?.kitName}</span>
        <span class="chip">标称 ${v.ladder?.nominals.map((n) => n.quantity.raw).join(' / ')}</span>
      </div>
    </div>
    <div class="mat-group">
      <div class="mat-title">分支 / 参数 / 时间基准</div>
      <div class="mat-items">
        ${v.branchOrder
          .map(
            (b) =>
              `<button class="btn small ${b === v.branchId ? 'active' : ''}" data-branch="${b}">分支 ${b}</button>`,
          )
          .join('')}
        <span class="chip">参数版本 <code>${v.paramVersion}</code></span>
        <span class="chip">时间基准 ${v.createdAt}</span>
        <button class="btn small" id="btnHead">回到最新</button>
      </div>
    </div>
  `;
  bar.querySelectorAll<HTMLButtonElement>('[data-branch]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.branch = btn.dataset.branch!;
      state.at = null;
      state.selection = null;
      loadProject(v.projectId);
    }),
  );
  const head = bar.querySelector('#btnHead')!;
  head.addEventListener('click', () => {
    state.at = null;
    state.selection = null;
    loadProject(v.projectId);
  });
  return bar;
}

function renderCanvasPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel canvas-panel';
  panel.innerHTML = `
    <div class="panel-head">
      <h2>原图叠加：lane 曲线 · 条带 · 有效区域 · 插值段 · 残差</h2>
      <div class="toggles">
        <label><input type="checkbox" id="tgProfile" ${state.showProfiles ? 'checked' : ''}/> 条带轮廓</label>
        <label><input type="checkbox" id="tgResidual" ${state.showResidual ? 'checked' : ''}/> 拟合残差</label>
      </div>
    </div>
    <div class="canvas-wrap"><canvas id="gelCanvas"></canvas></div>
    <div class="legend">
      <span><i style="background:#57c7ff"></i>ladder 道/插值段</span>
      <span><i style="background:#9be7a0"></i>样本道/唯一解</span>
      <span><i style="background:#ff5d5d"></i>饱和</span>
      <span><i style="background:#ffb347"></i>重叠/候选集</span>
      <span><i style="background:#c79bff"></i>拖尾/区间</span>
      <span><i style="background:#f0b43c"></i>缺带跨度/粗区间</span>
    </div>
    <canvas id="profileCanvas" class="profile-canvas"></canvas>
  `;
  panel.querySelector('#tgProfile')!.addEventListener('change', (e) => {
    state.showProfiles = (e.target as HTMLInputElement).checked;
    drawCanvas();
  });
  panel.querySelector('#tgResidual')!.addEventListener('change', (e) => {
    state.showResidual = (e.target as HTMLInputElement).checked;
    drawCanvas();
  });
  return panel;
}

function renderSidePanel(): HTMLElement {
  const side = document.createElement('aside');
  side.className = 'panel side-panel';
  side.appendChild(renderEvidenceDetail());
  side.appendChild(renderMwTable());
  side.appendChild(renderDiagnostics());
  side.appendChild(renderEventLog());
  return side;
}

function renderEvidenceDetail(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'detail-box';
  const v = state.view!;
  const sel = state.selection;
  if (!sel) {
    div.innerHTML = `<h3>证据往返</h3><p class="hint">点击图上的<b>分子量标签</b>回到 ladder 点与插值段；点击条带/ladder 点查看像素级来源。</p>`;
    return div;
  }
  const fits = v.analysis?.result.fits ?? [];
  const bandsById = new Map(v.bands.map((b) => [b.bandId, b]));
  let html = '<h3>证据链（可点击回溯）</h3>';

  if (sel.kind === 'inference') {
    const inf = v.analysis?.result.inferences.find((i) => i.inferenceId === sel.id);
    if (!inf) {
      html += '<p class="hint">该事件视图下尚无推断结果。回到更晚事件可查看。</p>';
    } else {
      const cand = v.adopted[inf.bandId]
        ? inf.candidates.find((c: any) => c.candidateId === v.adopted[inf.bandId])
        : inf.candidates[0];
      html += `<div class="kv"><b>推断身份</b><code>${inf.inferenceId}</code></div>`;
      html += `<div class="kv"><b>状态</b><span class="status ${inf.status}">${statusLabel(inf.status)}</span></div>`;
      html += `<div class="kv"><b>弧长坐标</b>${fmt(inf.inputSummary.arcLengthPx, 1)} px（沿中心线，非像素高度）</div>`;
      html += `<div class="kv"><b>曲率</b>${fmt(inf.inputSummary.curvaturePx, 1)} px</div>`;
      html += `<div class="kv"><b>参数版本</b><code>${inf.paramVersion}</code></div>`;
      if (cand) {
        html += `<div class="kv"><b>代表值</b>${cand.bpLabel}</div>`;
        html += `<div class="kv"><b>有效区间</b>s ${fmt(cand.validRegion.sMin, 1)}–${fmt(cand.validRegion.sMax, 1)} px；y ${cand.validRegion.yMin}–${cand.validRegion.yMax} px</div>`;
        html += `<div class="kv"><b>插值段</b><button class="link" data-pick='{"kind":"segment","id":"${cand.segmentId}"}'>${cand.segmentId}</button></div>`;
        html += `<div class="kv"><b>支撑 ladder 点</b>${cand.ladderBandIds
          .map((id: string) => `<button class="link" data-pick='{"kind":"ladder-band","id":"${id}"}'>${id.slice(-6)}</button>`)
          .join(' ')}</div>`;
      }
      html += '<h4>全部合法候选（采纳与未采纳均保留）</h4>';
      html += inf.candidates
        .map((c: any) => {
          const adopted = v.adopted[inf.bandId] === c.candidateId;
          return `<div class="cand ${adopted ? 'adopted' : ''}">
            <code>${c.candidateId}</code><br/>${c.bpLabel}
            <span class="muted">${reasonLabel(c.reason)}${c.bpLower ? `；区间 ${c.bpLower}–${c.bpUpper} bp` : ''}</span>
            <div class="row">
              <button class="btn tiny" data-accept='{"band":"${inf.bandId}","candidate":"${c.candidateId}"}'>${adopted ? '已采纳' : '采纳'}</button>
              <button class="btn tiny ghost" data-reject='{"band":"${inf.bandId}","candidate":"${c.candidateId}"}'>否定</button>
            </div>
          </div>`;
        })
        .join('');
      if (inf.diagnostics.length)
        html += `<div class="diag-mini">${inf.diagnostics.map((d: any) => `<span class="${d.severity}">${d.message}</span>`).join('<br/>')}</div>`;
    }
  } else if (sel.kind === 'ladder-band') {
    const b = bandsById.get(sel.id);
    const nominal = v.ladder?.nominals.find((n) => n.nominalId === b?.nominalId);
    const fit = fits[0];
    const res = fit?.residuals.find((r: any) => r.bandId === sel.id);
    html += `<div class="kv"><b>ladder 点</b><code>${sel.id}</code></div>`;
    html += `<div class="kv"><b>原图像素</b>(${b?.center.x}, ${b?.center.y}) px</div>`;
    html += `<div class="kv"><b>弧长 s</b>${fmt(b?.arcLengthPx, 1)} px</div>`;
    html += `<div class="kv"><b>标称值（原始表示）</b>${nominal?.quantity.raw ?? '（缺带/未匹配）'}</div>`;
    if (nominal?.quantity.bp !== undefined) html += `<div class="kv"><b>规范化</b>${nominal.quantity.bp} bp（单位 ${nominal.quantity.unit}）</div>`;
    if (res) html += `<div class="kv"><b>拟合残差</b>${fmt(res.residualPx, 2)} px（拟合 s=${fmt(res.fittedS, 1)}）</div>`;
    html += `<div class="kv"><b>来源</b>${b?.provenance.role}${b?.provenance.confidence != null ? `，置信度 ${b?.provenance.confidence}` : ''}</div>`;
  } else if (sel.kind === 'segment') {
    const seg = fits.flatMap((f) => f.segments).find((s) => s.segmentId === sel.id);
    if (seg) {
      html += `<div class="kv"><b>插值段</b><code>${seg.segmentId}</code></div>`;
      html += `<div class="kv"><b>状态</b><span class="status ${seg.status === 'valid' ? 'unique' : 'unresolved'}">${seg.status}</span></div>`;
      html += `<div class="kv"><b>有效区域</b>s ${fmt(seg.sMin, 1)}–${fmt(seg.sMax, 1)} px；y ${seg.yMin}–${seg.yMax} px</div>`;
      html += `<div class="kv"><b>局部标尺</b>log10(bp) = ${fmt(seg.intercept, 4)} − ${fmt(seg.slope, 5)}·s</div>`;
      html += `<div class="kv"><b>端点 ladder 点</b>
        <button class="link" data-pick='{"kind":"ladder-band","id":"${seg.highBandId}"}'>高分子量端</button>
        <button class="link" data-pick='{"kind":"ladder-band","id":"${seg.lowBandId}"}'>低分子量端</button></div>`;
      if (seg.status !== 'valid') html += `<p class="hint warn">失效原因：${seg.status === 'non-monotonic' ? '非单调标尺，语义无解' : '跨过缺带，仅支持粗区间'}</p>`;
    }
  } else if (sel.kind === 'band') {
    const b = bandsById.get(sel.id);
    html += `<div class="kv"><b>条带</b><code>${sel.id}</code></div>`;
    html += `<div class="kv"><b>中心（像素）</b>(${b?.center.x}, ${b?.center.y}) px</div>`;
    html += `<div class="kv"><b>弧长 s</b>${fmt(b?.arcLengthPx, 1)} px</div>`;
    html += `<div class="kv"><b>峰强</b>${b?.peakIntensity}${b?.saturated ? '（饱和）' : ''}</div>`;
    html += `<div class="kv"><b>标志</b>${[b?.saturated ? '饱和' : '', b?.tailed ? '拖尾' : '', b?.overlapsWith?.length ? '重叠' : ''].filter(Boolean).join('、') || '正常'}</div>`;
    html += `<div class="kv"><b>来源</b>${b?.provenance.role} — ${b?.provenance.note ?? ''}</div>`;
  }

  div.innerHTML = html;
  div.querySelectorAll<HTMLElement>('[data-pick]').forEach((el) =>
    el.addEventListener('click', () => {
      state.selection = JSON.parse(el.dataset.pick!);
      render();
    }),
  );
  div.querySelectorAll<HTMLElement>('[data-accept]').forEach((el) =>
    el.addEventListener('click', async () => {
      const d = JSON.parse(el.dataset.accept!);
      await decide({ action: 'accept', targetKind: 'molecular-weight', targetId: d.band, acceptedCandidateId: d.candidate, reason: '界面接受候选' });
    }),
  );
  div.querySelectorAll<HTMLElement>('[data-reject]').forEach((el) =>
    el.addEventListener('click', async () => {
      const d = JSON.parse(el.dataset.reject!);
      await decide({ action: 'reject', targetKind: 'molecular-weight', targetId: d.band, rejectedCandidateIds: [d.candidate], reason: '界面否定候选' });
    }),
  );
  return div;
}

async function decide(detail: Record<string, unknown>) {
  const v = state.view!;
  await api(`/api/project/${encodeURIComponent(v.projectId)}/decision?branch=${encodeURIComponent(state.branch)}`, {
    method: 'POST',
    body: JSON.stringify({ detail }),
  });
  await loadProject(v.projectId);
  toast('已生成新的决定事件（历史不被覆盖）');
}

function renderMwTable(): HTMLElement {
  const v = state.view!;
  const box = document.createElement('div');
  box.className = 'detail-box';
  const inferences = v.analysis?.result.inferences ?? [];
  const lanesById = new Map(v.lanes.map((l) => [l.laneId, l]));
  const bandsById = new Map(v.bands.map((b) => [b.bandId, b]));
  box.innerHTML = `<h3>分子量推断（每个显示值带稳定身份）</h3>
    <table class="mw-table">
      <thead><tr><th>泳道</th><th>像素(x,y)</th><th>s(px)</th><th>状态</th><th>代表值</th><th>区间(bp)</th><th>身份</th></tr></thead>
      <tbody>${inferences
        .map((inf) => {
          const b = bandsById.get(inf.bandId);
          const lane = lanesById.get(inf.laneId);
          const chosenId = v.adopted[inf.bandId];
          const c = chosenId
            ? inf.candidates.find((x: any) => x.candidateId === chosenId)
            : inf.candidates[0];
          return `<tr data-inf="${inf.inferenceId}" class="clickable">
            <td>${lane?.label ?? inf.laneId.slice(-4)}</td>
            <td>${b ? `${b.center.x},${b.center.y}` : '—'}</td>
            <td>${fmt(b?.arcLengthPx, 1)}</td>
            <td><span class="status ${inf.status}">${statusLabel(inf.status)}</span></td>
            <td>${c ? c.bpLabel : '无解'}</td>
            <td>${c?.bpLower ? `${c.bpLower}–${c.bpUpper}` : '—'}</td>
            <td><code title="${inf.inferenceId}">${inf.inferenceId.slice(0, 14)}…</code></td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  box.querySelectorAll<HTMLElement>('tr[data-inf]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.selection = { kind: 'inference', id: (tr as HTMLElement).dataset.inf! };
      render();
    }),
  );
  return box;
}

function renderDiagnostics(): HTMLElement {
  const v = state.view!;
  const diags = v.analysis?.result.diagnostics ?? [];
  const box = document.createElement('div');
  box.className = 'detail-box diag-box';
  const conflicts = v.conflicts ?? [];
  box.innerHTML = `<h3>诊断与失效原因（带位置）${conflicts.length ? ' · ⚠ 冲突决定' : ''}</h3>
    ${conflicts
      .map(
        (c) =>
          `<div class="diag error">互相冲突的人工决定：对象 <code>${c.targetId}</code> 被 ${c.decisions.length} 个决定采纳为不同候选</div>`,
      )
      .join('')}
    ${
      diags.length
        ? diags
            .map(
              (d) =>
                `<div class="diag ${d.severity}"><b>[${d.code}]</b> ${d.message}${
                  d.location ? ` <span class="muted">@ ${JSON.stringify(d.location)}</span>` : ''
                }</div>`,
            )
            .join('')
        : '<p class="hint">无诊断。</p>'
    }`;
  return box;
}

function renderEventLog(): HTMLElement {
  const v = state.view!;
  const box = document.createElement('div');
  box.className = 'detail-box event-box';
  box.innerHTML = `<h3>决定历史（点击任意旧事件恢复当时依赖版本与结论）</h3>
    <ol class="events">${v.events
      .map(
        (e) => `<li class="event ${state.at === e.eventId ? 'at' : ''}" data-event="${e.eventId}">
          <span class="seq">#${e.seq}</span>
          <span class="etype">${e.type}</span>
          <span class="muted">${e.branchId}</span>
          <code class="pv">${e.paramVersion}</code>
          <span class="muted" title="${e.parents.join(', ')}">↰${e.parents.length}</span>
          <code class="hash" title="${e.eventId}">${e.selfHash}</code>
        </li>`,
      )
      .join('')}</ol>`;
  box.querySelectorAll('.event').forEach((li) =>
    li.addEventListener('click', () => {
      state.at = (li as HTMLElement).dataset.event!;
      state.selection = null;
      loadProject(v.projectId);
    }),
  );
  return box;
}

function statusLabel(s: string): string {
  return (
    {
      unique: '唯一解',
      'candidate-set': '候选集',
      interval: '区间',
      coarse: '粗区间',
      unresolved: '无解',
      valid: '有效',
      'non-monotonic': '非单调',
      'missing-span': '缺带跨度',
      'outside-support': '出有效区域',
    } as Record<string, string>
  )[s] ?? s;
}

function reasonLabel(r: string): string {
  return (
    {
      unique: '唯一',
      saturated: '饱和',
      overlap: '重叠',
      tail: '拖尾',
      'missing-span': '缺带跨度',
      'non-monotonic': '非单调',
      'outside-region': '出有效区域',
    } as Record<string, string>
  )[r] ?? r;
}

let imgBitmap: HTMLImageElement | null = null;
let imgUrlKey = '';

async function drawCanvas() {
  const v = state.view;
  const canvas = document.querySelector('#gelCanvas') as HTMLCanvasElement | null;
  if (!v || !v.image || !canvas) return;
  const url = `/api/project/${encodeURIComponent(v.projectId)}/image`;
  if (!imgBitmap || imgUrlKey !== url) {
    imgBitmap = await loadImage(url);
    imgUrlKey = url;
  }
  const maxW = Math.min(620, window.innerWidth - 520);
  const scale = Math.max(0.5, Math.min(1.4, maxW / v.image.width));
  canvas.width = Math.round(v.image.width * scale);
  canvas.height = Math.round(v.image.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(imgBitmap, 0, 0, canvas.width, canvas.height);
  const pick = drawOverlay(ctx, v, scale, state.selection, (sel) => {
    state.selection = sel;
    render();
  });
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    pick(e.clientX - rect.left, e.clientY - rect.top);
  };
  if (state.showResidual) drawResidualHint(ctx, v, scale);
  if (state.showProfiles) drawProfiles();
}

function drawResidualHint(ctx: CanvasRenderingContext2D, v: ProjectView, scale: number) {
  // 残差已在 overlay 中绘制；此处仅在角标给出最大残差。
  const residuals = v.analysis?.result.fits.flatMap((f) => f.residuals) ?? [];
  const max = residuals.reduce((m, r) => Math.max(m, Math.abs(r.residualPx)), 0);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(4, 4, 150, 16);
  ctx.fillStyle = '#9be7a0';
  ctx.fillText(`最大拟合残差 ${fmt(max, 2)} px`, 8, 16);
  ctx.restore();
}

function drawProfiles() {
  const v = state.view!;
  const pc = document.querySelector('#profileCanvas') as HTMLCanvasElement | null;
  if (!pc) return;
  const profiles = v.analysis?.result.profiles ?? [];
  if (!profiles.length) {
    pc.hidden = true;
    return;
  }
  pc.hidden = false;
  const W = (pc.parentElement!.clientWidth ?? 600) - 24;
  const H = 110;
  pc.width = W;
  pc.height = H;
  const ctx = pc.getContext('2d')!;
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(0, 0, W, H);
  const lanesById = new Map(v.lanes.map((l) => [l.laneId, l]));
  const colors = ['#57c7ff', '#9be7a0', '#ffd166', '#c79bff'];
  profiles.forEach((prof, li) => {
    if (!prof.length) return;
    const sMax = prof[prof.length - 1]!.s;
    const iMax = Math.max(...prof.map((p) => p.intensity));
    ctx.beginPath();
    prof.forEach((p, i) => {
      const x = (p.s / sMax) * (W - 40) + 34;
      const y = H - 8 - (p.intensity / iMax) * (H - 22);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors[li % colors.length]!;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const lane = lanesById.get(prof[0]!.laneId);
    ctx.fillStyle = colors[li % colors.length]!;
    ctx.font = '9px monospace';
    ctx.fillText(lane?.label ?? `L${li}`, 4, 14 + li * 11);
  });
  ctx.fillStyle = '#7d8896';
  ctx.font = '9px monospace';
  ctx.fillText('条带轮廓：沿泳道中心线弧长 s(px) → 平均灰度', 40, H - 1);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

loadProjects();
