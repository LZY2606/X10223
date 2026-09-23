import type { AnalysisResult, BandMaterial, GelEvent, LaneMaterial } from '../domain/types';

interface State {
  project: { id: string; name: string };
  image: { sha256: string; width: number; height: number; url: string } | null;
  materials: import('../domain/types').Material[];
  params: import('../domain/types').ParamSet[];
  branches: import('../domain/types').BranchInfo[];
  events: GelEvent[];
  results: AnalysisResult[];
  resultBranch: string;
  archives: unknown[];
}

let state: State | null = null;
let selectedBandId: string | null = null;
let traceMw: { bandId: string } | null = null;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : init?.headers,
    cache: 'no-store'
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? `${json.failure ?? 'error'}: ${json.error}` : res.statusText);
  return json;
}

async function refresh(branch?: string): Promise<void> {
  state = await api(`/api/state${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`);
  render();
}

const app = document.querySelector<HTMLDivElement>('#app')!;

function render(): void {
  if (!state) return;
  const lanes = state.materials.filter((m): m is LaneMaterial => m.kind === 'lane');
  const bands = state.materials.filter((m): m is BandMaterial => m.kind === 'band');
  const orient = state.materials.find((m) => m.kind === 'orientation') as { rotation90: number; flipH: boolean; flipV: boolean; raw: unknown } | undefined;
  const exposure = state.materials.find((m) => m.kind === 'exposure') as { exposureS: number | null; gain: number | null; saturationLevel: number | null } | undefined;
  const ladder = state.materials.find((m) => m.kind === 'ladderNominal') as { entries: { row: number; token: string; mass: number | null; diagnostic: string | null }[] } | undefined;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>胶道标尺 · 电泳条带 / 泳道弯曲 / 分子量校准</h1>
        <div class="sub">坐标基准：原图左上角像素 · 迁移单位：沿 lane 曲线弧长 px · 质量：bp · 时间：Unix ms</div>
      </div>
      <div class="toolbar">
        ${state.branches.map((b) => `<button class="branch ${b.id === state!.resultBranch ? 'on' : ''}" data-branch="${b.id}">${b.name}</button>`).join('')}
        <button id="btn-export">导出项目</button>
        <label class="import-btn">导入项目<input type="file" id="import-file" accept="application/json" hidden /></label>
        <button id="btn-roundtrip">导出→删除→导入自检</button>
      </div>
    </header>
    <main class="grid">
      <section class="panel canvas-panel">
        <div class="panel-h">
          <h2>证据叠加复核</h2>
          <div class="legend"><span class="dot lane"></span>lane 曲线 <span class="dot band"></span>条带中心 <span class="dot prof"></span>轮廓 <span class="dot res"></span>ladder 残差</div>
        </div>
        <div class="svgwrap">${svgOverlay(lanes, bands, orient)}</div>
        <div class="tracebox" id="tracebox">${traceInfo()}</div>
      </section>
      <section class="panel side">
        <details open><summary>不可变材料（像素级来源）</summary><div class="materials">${materialsBlock(orient, exposure, ladder)}</div></details>
        <details open><summary>分子量推断（点击数值回溯 ladder 段）</summary><div id="mwtable">${mwTable()}</div></details>
        <details open><summary>拟合残差</summary><div id="residuals">${residualsBlock()}</div></details>
        <details><summary>反例档案（采纳/未采纳均保留）</summary><div id="archive">${archiveBlock()}</div></details>
      </section>
    </main>
    <section class="panel timeline-panel">
      <div class="panel-h"><h2>决定历史（点击旧事件恢复当时结论）</h2><div class="sub">分支与参数版本随事件固定，最新计算不覆盖历史</div></div>
      <div class="timeline">${timeline()}</div>
    </section>
    <div id="toast" class="toast hidden"></div>`;
  bind(lanes, bands);
}
