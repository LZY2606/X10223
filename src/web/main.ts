import './style.css'
import { drawGel, pickArtifacts, type ReviewData } from './render'

interface ProjectOpt { projectId: string; name: string; createdAt: string }

const state = {
  projects: [] as ProjectOpt[],
  projectId: '',
  branch: '',
  until: null as string | null,
  data: null as ReviewData | null,
  img: null as HTMLImageElement | null,
  selectedBand: undefined as string | undefined,
  highlightSegment: undefined as number | undefined,
  showProfile: true,
  showResiduals: true,
  tab: 'mw'
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(path, init)
  const body = await r.json()
  if (!r.ok) throw Object.assign(new Error(body.message ?? 'error'), body)
  return body
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return e
}

function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const t = el('div', { class: 'toast', style: `border-color:${kind === 'ok' ? '#3fb950' : '#f85149'}` }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), 4000)
}

async function loadProjects(selectId?: string): Promise<void> {
  const { projects } = await api('/api/projects')
  state.projects = projects
  const sel = document.getElementById('projectSel') as HTMLSelectElement
  sel.innerHTML = ''
  for (const p of projects) sel.append(el('option', { value: p.projectId }, `${p.name}`))
  state.projectId = selectId ?? projects[0]?.projectId
  sel.value = state.projectId
  await loadReview()
}

async function loadReview(): Promise<void> {
  if (!state.projectId) return
  const params = new URLSearchParams()
  if (state.branch) params.set('branch', state.branch)
  if (state.until) params.set('until', state.until)
  state.data = await api(`/api/projects/${state.projectId}/review?${params}`)
  state.branch = state.data.branch
  const branchSel = document.getElementById('branchSel') as HTMLSelectElement
  branchSel.innerHTML = ''
  for (const b of state.data.branches) branchSel.append(el('option', { value: b.branchId }, `${b.label} (${b.branchId})`))
  branchSel.value = state.branch
  await loadImage()
  renderPanels()
}

async function loadImage(): Promise<void> {
  if (!state.data || state.data.imageIds.length === 0) return
  const imageId = state.data.imageIds[0]
  const url = `/api/images/${imageId}.png?projectId=${encodeURIComponent(state.projectId)}&v=${state.until ?? 'head'}`
  await new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      state.img = img
      const canvas = document.getElementById('gelCanvas') as HTMLCanvasElement
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      resolve()
    }
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
  redraw()
}

function redraw(): void {
  const canvas = document.getElementById('gelCanvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')
  if (ctx && state.img && state.data) {
    drawGel(ctx, state.img, state.data, {
      selectedBand: state.selectedBand,
      highlightSegment: state.highlightSegment,
      showProfile: state.showProfile,
      showResiduals: state.showResiduals,
      validOnly: false
    })
  }
}

function selectBand(bandId: string | undefined, segmentIndex: number | undefined): void {
  state.selectedBand = bandId
  state.highlightSegment = segmentIndex
  redraw()
  renderMw()
}

function renderPanels(): void {
  renderHeader()
  renderMw()
  renderEvents()
  renderDiags()
  renderMaterials()
  const tabs = document.querySelectorAll('.tabs button')
  tabs.forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === state.tab))
}

function renderHeader(): void {
  if (!state.data) return
  const { detection, calibration } = pickArtifacts(state.data.artifacts)
  const orient = state.data.events.find((e) => e.type === 'orientation_declared') as { rotationDeg?: number } | undefined
  const expo = state.data.events.find((e) => e.type === 'exposure_declared') as { exposure?: { raw?: string } } | undefined
  const basis = document.getElementById('basisBar') as HTMLElement
  basis.innerHTML = ''
  basis.append(
    el('span', { class: 'basis' }, `坐标基准: oriented_image px（旋转 ${orient?.rotationDeg ?? 0}°，原点左上，迁移向下）`),
    el('span', { class: 'basis' }, `时间基准: ${expo?.exposure?.raw ?? '—'}`),
    el('span', { class: 'basis' }, `参数版本: ${state.data.replay.paramsVersion}`),
    el('span', { class: 'basis' }, `标尺状态: ${calibration?.status ?? '—'}`),
    el('span', { class: 'basis' }, `有效区间 r: ${calibration ? calibration.validS.map((v) => (Number.isNaN(v) ? 'NaN' : v.toFixed(3))).join(' ~ ') : '—'}`),
    el('span', { class: 'basis' }, `单位: ${calibration?.unit ?? 'bp'}`),
    el('span', { class: 'basis' }, `检测预算: ${detection ? `${detection.budget.pixels}/${detection.budget.budgetPixels}px` : '—'}`)
  )
}

function mwText(inf: NonNullable<ReturnType<typeof pickArtifacts>['mw']>['inferences'][number]): string {
  if (inf.state === 'unique' && inf.unique) return `${inf.unique.value} ${inf.unique.unit}`
  if (inf.state === 'interval' && inf.interval) return `[${inf.interval[0].value}, ${inf.interval[1].value}] ${inf.interval[0].unit}`
  if (inf.state === 'candidates' && inf.candidates) return inf.candidates.map((c) => `${c.value}`).join(' / ') + ` ${inf.candidates[0]?.unit ?? ''}`
  return 'invalid'
}

function renderMw(): void {
  const body = document.getElementById('tabMw') as HTMLElement
  body.innerHTML = ''
  if (!state.data) return
  const { calibration, mw, detection } = pickArtifacts(state.data.artifacts)
  body.append(el('h3', { class: 'small', style: 'margin:4px 0 8px' }, '分子量推断（点击任一行 → 回到 ladder 点与插值段）'))
  if (!mw) {
    body.append(el('div', { class: 'diag error' }, '尚无可显示推断结果。'))
    return
  }
  const byLane = new Map<string, typeof mw.inferences>()
  for (const inf of mw.inferences) {
    const arr = byLane.get(inf.laneId) ?? []
    arr.push(inf)
    byLane.set(inf.laneId, arr)
  }
  for (const [laneId, infs] of byLane) {
    const lane = detection?.proposedLanes.find((l) => l.laneId === laneId)
    body.append(el('div', { class: 'card' }, el('h3', {}, `${lane?.label ?? laneId}`)))
    const card = body.lastElementChild as HTMLElement
    for (const inf of infs.sort((a, b) => a.s - b.s)) {
      const row = el('div', { class: 'mw-row' + (state.selectedBand === inf.bandId ? ' selected' : '') })
      row.append(
        el('span', { class: 'mw-lane' }, `s=${inf.s.toFixed(0)}px`),
        el('span', { class: 'badge ' + inf.state }, inf.state),
        el('span', { class: 'mw-val' }, mwText(inf))
      )
      if (inf.segmentIndex !== undefined) {
        const seg = calibration?.segments[inf.segmentIndex]
        row.append(el('span', { class: 'small' }, seg ? `段#${seg.index} r[${seg.s0.toFixed(2)},${seg.s1.toFixed(2)}]` : ''))
      }
      row.addEventListener('click', () => {
        selectBand(inf.bandId, inf.segmentIndex)
        const seg = calibration?.segments[inf.segmentIndex ?? -1]
        toast(
          inf.state === 'invalid'
            ? `失效原因：${inf.reasons.join(', ') || 'outside valid region'}；不外推`
            : `已定位到 ladder 点 ${seg?.pointIds.join(' ↔ ')} 与插值段 #${inf.segmentIndex}（参数 ${mw.inputDigest.paramsVersion}）`
        )
      })
      card.append(row)
      if (inf.diagnostics.length) {
        for (const d of inf.diagnostics) card.append(el('div', { class: `diag ${d.severity}` }, d.message))
      }
    }
  }
}

function renderEvents(): void {
  const body = document.getElementById('tabEvents') as HTMLElement
  body.innerHTML = ''
  if (!state.data) return
  body.append(el('div', { class: 'small', style: 'margin-bottom:8px' }, '事件历史（内容寻址、只追加）。点击任一旧事件 → 恢复当时依赖版本与可见结论。'))
  for (const e of [...state.data.events].reverse()) {
    const div = el('div', { class: 'ev' + (state.until === e.eventId ? ' current' : '') })
    const typeLabel: Record<string, string> = {
      project_created: '建项目', image_added: '原图', orientation_declared: '拍摄方向', exposure_declared: '曝光',
      ladder_nominal_set: 'ladder 标称', lane_boundaries_set: 'lane 边界', band_centers_set: '条带中心',
      detection_run: '自动检测', decision: '人工决定'
    }
    div.append(el('div', {}, el('span', { class: 'ev-seq' }, `#${e.seq}`), el('span', { class: 'ev-type' }, typeLabel[e.type] ?? e.type)))
    const reason = (e as { reason?: string }).reason ?? (e as { label?: string }).label
    if (reason) div.append(el('div', { class: 'ev-reason' }, String(reason)))
    div.append(el('div', { class: 'ev-reason' }, `${e.eventId.slice(0, 18)}… · ${e.at.slice(0, 19)}`))
    div.addEventListener('click', async () => {
      state.until = state.until === e.eventId ? null : e.eventId
      state.selectedBand = undefined
      state.highlightSegment = undefined
      await loadReview()
      toast(state.until ? `已回到事件 #${e.seq}（历史版本，不被最新结果覆盖）` : '已回到最新状态')
    })
    body.append(div)
  }
}

function renderDiags(): void {
  const body = document.getElementById('tabDiag') as HTMLElement
  body.innerHTML = ''
  if (!state.data) return
  const diags = state.data.replay.diagnostics
  body.append(el('div', { class: 'small', style: 'margin-bottom:8px' }, `诊断（带位置）；共 ${diags.length} 条。输入不完整返回诊断而非空值。`))
  if (!diags.length) body.append(el('div', { class: 'diag info' }, '无诊断：所有必需来源完整。'))
  for (const d of diags) {
    const loc = d.at ? ` @ ${d.at.laneId ? d.at.laneId + ' ' : ''}(${Math.round(d.at.x ?? 0)},${Math.round(d.at.y ?? 0)})` : ''
    body.append(el('div', { class: `diag ${d.severity}` }, `[${d.code}] ${d.message}${loc}`))
  }
}

function renderMaterials(): void {
  const body = document.getElementById('tabMaterials') as HTMLElement
  body.innerHTML = ''
  if (!state.data) return
  const img = state.data.events.find((e) => e.type === 'image_added') as { name?: string; sha256?: string; byteLength?: number } | undefined
  const ladder = state.data.events.find((e) => e.type === 'ladder_nominal_set') as { entries?: { slot: number; raw: string; declaredMissing?: boolean }[]; revision?: number } | undefined
  body.append(el('div', { class: 'card' },
    el('h3', {}, '不可变材料 / 像素级来源'),
    el('div', { class: 'kv' },
      el('span', { class: 'k' }, '原图'), el('span', {}, `${img?.name ?? ''} sha=${(img?.sha256 ?? '').slice(0, 16)}… ${img?.byteLength ?? 0}B`),
      el('span', { class: 'k' }, 'ladder 版本'), el('span', {}, `v${ladder?.revision ?? 1}`),
      el('span', { class: 'k' }, 'lane 版本'), el('span', {}, `v${state.data.replay.lanesRevision}`),
      el('span', { class: 'k' }, 'band 版本'), el('span', {}, `v${state.data.replay.bandsRevision}`)
    )))
  if (ladder?.entries) {
    const card = el('div', { class: 'card' }, el('h3', {}, 'ladder 标称（保留原始表示）'))
    for (const en of ladder.entries) {
      card.append(el('div', {}, `槽 ${en.slot}: ${en.raw}${en.declaredMissing ? ' （声明缺带）' : ''}`))
    }
    body.append(card)
  }
}

function init(): void {
  const app = document.getElementById('app') as HTMLElement
  app.innerHTML = `
    <header>
      <h1>胶道标尺 · 电泳条带 / 泳道弯曲 / 分子量校准工作台</h1>
      <select id="projectSel" style="min-width:280px"></select>
      <select id="branchSel"></select>
      <label class="small"><input type="checkbox" id="chkProfile" checked /> 轮廓</label>
      <label class="small"><input type="checkbox" id="chkResid" checked /> 残差</label>
      <button id="btnExport">导出归档</button>
      <button id="btnImport">导出→删库→导入自测</button>
      <button id="btnBackHead">回到最新</button>
      <span id="basisBar" style="display:flex;gap:14px;flex-wrap:wrap;width:100%"></span>
    </header>
    <div class="layout">
      <div class="canvas-wrap">
        <div class="legend">
          <span class="lg-lane">lane 曲线</span><span class="lg-ladder">ladder 道/有效区</span>
          <span class="lg-band">条带中心(颜色=推断状态)</span><span class="lg-resid">拟合残差</span>
          <span class="lg-seg">选中插值段</span>
        </div>
        <canvas id="gelCanvas"></canvas>
      </div>
      <div class="side">
        <div class="tabs">
          <button data-tab="mw" class="active">分子量</button>
          <button data-tab="events">事件/分支</button>
          <button data-tab="diag">诊断</button>
          <button data-tab="materials">材料</button>
        </div>
        <div class="tab-body">
          <div id="tabMw"></div><div id="tabEvents" style="display:none"></div>
          <div id="tabDiag" style="display:none"></div><div id="tabMaterials" style="display:none"></div>
        </div>
      </div>
    </div>`

  document.getElementById('projectSel')!.addEventListener('change', async (e) => {
    state.projectId = (e.target as HTMLSelectElement).value
    state.until = null
    await loadReview()
  })
  document.getElementById('branchSel')!.addEventListener('change', async (e) => {
    state.branch = (e.target as HTMLSelectElement).value
    state.until = null
    await loadReview()
  })
  document.getElementById('chkProfile')!.addEventListener('change', (e) => { state.showProfile = (e.target as HTMLInputElement).checked; redraw() })
  document.getElementById('chkResid')!.addEventListener('change', (e) => { state.showResiduals = (e.target as HTMLInputElement).checked; redraw() })
  document.getElementById('btnBackHead')!.addEventListener('click', async () => { state.until = null; await loadReview() })
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = (b as HTMLElement).dataset.tab!
      ;['tabMw', 'tabEvents', 'tabDiag', 'tabMaterials'].forEach((id) => {
        ;(document.getElementById(id) as HTMLElement).style.display = id === 'tab' + state.tab.charAt(0).toUpperCase() + state.tab.slice(1) ? 'block' : 'none'
      })
      document.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === state.tab))
    })
  )
  document.getElementById('btnExport')!.addEventListener('click', async () => {
    const r = await api('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: state.projectId }) })
    toast(`已原子导出：${r.path}（sha ${r.sha.slice(0, 12)}…）`)
  })
  document.getElementById('btnImport')!.addEventListener('click', async () => {
    try {
      const r = await api('/api/roundtrip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: state.projectId }) })
      toast(`往返成功：身份/顺序/来源保持，sha=${r.sha.slice(0, 12)}…`)
      await loadProjects(r.projectId)
    } catch (e) {
      toast('往返失败：' + (e as Error).message, 'err')
    }
  })

  void loadProjects()
}

init()
