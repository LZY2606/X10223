/* 胶道标尺审阅页:叠加原图/lane 曲线/条带轮廓/拟合残差,点击分子量回到 ladder 点与插值段。 */

interface View {
  image: { w: number; h: number; orientationDeg: 0 | 90 | 180 | 270 };
  exposure: { raw: string; value: number; unit: string } | null;
  lanes: { laneId: string; curve: { c0: number; c1: number; c2: number }; derivedId: string }[];
  ruler: { a: number; b: number; dMin: number; dMax: number; unit: string; basis: string;
           points: { d: number; mw: number }[]; residuals: number[] } | null;
  bands: BandView[];
  events: Ev[];
  branches: { id: string }[];
}
interface BandView {
  id: string; laneId: string; x: number; y: number; status: string; reasons: string[];
  inference: null | {
    bandId: string; laneId: string; dEff: number; smileCorrection: number;
    validRegion: { dMin: number; dMax: number; unit: string; basis: string };
    status: string; reasons: string[];
    value: { kind: string; mw?: number; logMw?: number; lo?: number; hi?: number; options?: number[]; reason?: string; unit?: string };
    derivedId: string; paramVersion: string; inputDigest: string; parents: string[];
  };
}
interface Ev { id: string; seq: number; branchId: string; kind: string; payload: any; }
interface State { materials: { id: string; kind: string; payload: any }[]; digest: string; events: Ev[]; }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

let view: View;
let state: State;
let selected: BandView | null = null;

function normDims() {
  const { w, h, orientationDeg } = view.image;
  return orientationDeg === 90 || orientationDeg === 270 ? { w: h, h: w } : { w, h };
}
function imageMatrix(): string {
  const { w, h, orientationDeg } = view.image;
  switch (orientationDeg) {
    case 0: return "matrix(1 0 0 1 0 0)";
    case 90: return `matrix(0 -1 1 0 0 ${w - 1})`;
    case 180: return `matrix(-1 0 0 -1 ${w - 1} ${h - 1})`;
    case 270: return `matrix(0 1 -1 0 ${h - 1} 0)`;
  }
}
const statusColor = (s: string) => s === "accepted" ? "var(--ok)" : s === "candidate" ? "var(--warn)" : s === "interval" ? "var(--bad)" : "var(--dim)";

async function refresh() {
  view = (await api("/api/view")).body as View;
  state = (await api("/api/state")).body as State;
  $("#digest").textContent = `digest ${state.digest.slice(4, 16)} · ${state.events.length} 事件`;
  renderGel();
  renderRuler();
  renderEvents();
  renderDetail();
}

function renderGel() {
  const { w, h } = normDims();
  const svg = $("#gel") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.style.maxHeight = "70vh";
  const showImage = ($("#ov-image") as HTMLInputElement).checked;
  const showLanes = ($("#ov-lanes") as HTMLInputElement).checked;
  const showBands = ($("#ov-bands") as HTMLInputElement).checked;
  let s = "";
  if (showImage) s += `<image href="/api/image" x="0" y="0" width="${view.image.w}" height="${view.image.h}" transform="${imageMatrix()}" opacity="0.9" pointer-events="none"/>`;
  if (showLanes) for (const l of view.lanes) {
    const pts: string[] = [];
    for (let y = 0; y <= h; y += 12) pts.push(`${(l.curve.c0 + l.curve.c1 * y + l.curve.c2 * y * y).toFixed(1)},${y}`);
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--acc)" stroke-width="1" opacity="0.7" pointer-events="none"/>`;
    s += `<text x="${l.curve.c0 - 12}" y="16" fill="var(--acc)" pointer-events="none">${l.laneId}</text>`;
  }
  if (showBands) for (const b of view.bands) {
    const c = statusColor(b.status);
    const wsel = selected?.id === b.id ? 3.5 : 1.5;
    s += `<ellipse class="band" data-id="${b.id}" cx="${b.x}" cy="${b.y}" rx="16" ry="6" fill="transparent" stroke="${c}" stroke-width="${wsel}"/>`;
    s += `<text x="${b.x + 18}" y="${b.y + 3}" fill="${c}" pointer-events="none">${b.id}</text>`;
  }
  svg.innerHTML = s;
  svg.querySelectorAll(".band").forEach((el) => el.addEventListener("click", () => {
    selected = view.bands.find((b) => b.id === (el as SVGEllipseElement).dataset.id)!;
    renderGel(); renderDetail(); renderRuler();
  }));
}

function mwText(inf: NonNullable<BandView["inference"]>): string {
  const v = inf.value;
  if (v.kind === "point") return `${v.mw!.toFixed(0)} bp`;
  if (v.kind === "interval") return `[${v.lo!.toFixed(0)}, ${v.hi!.toFixed(0)}] bp · ${v.reason}`;
  return `候选: ${(v.options ?? []).map((o) => o.toFixed(0) + " bp").join(" / ")} · ${v.reason}`;
}

function renderDetail() {
  const el = $("#detail");
  if (!selected || !selected.inference) {
    el.innerHTML = `<h2>条带详情</h2><div class="muted">${selected ? "该条带尚无推断结果" : "点击图中的条带轮廓"}</div>`;
    return;
  }
  const inf = selected.inference;
  const tagCls = inf.status === "accepted" ? "ok" : inf.status === "candidate" ? "warn" : "bad";
  el.innerHTML = `<h2>条带详情 · ${selected.id}</h2>
    <div class="kv">
      <b>分子量</b><span><a id="mw-link">${mwText(inf)}</a> <span class="muted">(点击回到 ladder 点与插值段)</span></span>
      <b>状态</b><span><span class="tag ${tagCls}">${inf.status}</span>${inf.reasons.map((r) => `<span class="tag warn">${r}</span>`).join("")}</span>
      <b>泳道</b><span>${inf.laneId}</span>
      <b>坐标基准</b><span>${inf.validRegion.basis} · 单位 ${inf.validRegion.unit}</span>
      <b>有效区间</b><span>d ∈ [${inf.validRegion.dMin.toFixed(1)}, ${inf.validRegion.dMax.toFixed(1)}] px</span>
      <b>微笑校正</b><span>${inf.smileCorrection.toFixed(2)} px(d_eff = ${inf.dEff.toFixed(1)} px)</span>
      <b>曝光</b><span>${view.exposure ? `${view.exposure.raw}(已规范化 ${view.exposure.value} ${view.exposure.unit})` : "缺失"}</span>
      <b>拍摄方向</b><span>${view.image.orientationDeg}°(原图按 raw 像素保留)</span>
      <b>参数版本</b><span>${inf.paramVersion}</span>
      <b>输入摘要</b><span>${inf.inputDigest.slice(0, 28)}…</span>
      <b>父级依赖</b><span class="muted">${inf.parents.map((p) => p.slice(0, 14)).join(", ")}…</span>
    </div>
    <div style="margin-top:8px">
      <button data-dec="decision:accept">接受</button>
      <button data-dec="decision:reject">否定</button>
      <button data-dec="decision:param-adjust">调整参数</button>
    </div>`;
  $("#mw-link").addEventListener("click", () => renderRuler(true));
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", async () => {
    const kind = (b as HTMLButtonElement).dataset.dec!;
    await api("/api/decision", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, targetIds: [inf.derivedId], note: `${kind} on ${selected!.id}`, branchId: kind === "decision:reject" ? "review-b" : "main" }) });
    await refresh();
  }));
}

function renderRuler(flash = false) {
  const svg = $("#ruler") as unknown as SVGSVGElement;
  const r = view.ruler;
  if (!r) { svg.innerHTML = `<text x="8" y="20" fill="var(--dim)">无标尺</text>`; return; }
  const Wpx = 380, Hpx = 190, pad = 30;
  const xs = (d: number) => pad + ((d - 0) / (r.dMax + 20)) * (Wpx - pad - 10);
  const ys = (l: number) => Hpx - pad - ((l - 2.8) / (4.2 - 2.8)) * (Hpx - pad - 10);
  let s = `<rect x="${xs(r.dMin)}" y="10" width="${xs(r.dMax) - xs(r.dMin)}" height="${Hpx - pad - 10}" fill="#5ec1ff11"/>`;
  s += `<text x="${xs(r.dMin)}" y="20" fill="var(--dim)">有效区间 [${r.dMin.toFixed(0)}, ${r.dMax.toFixed(0)}] px · ${r.basis}</text>`;
  s += `<line x1="${xs(0)}" y1="${ys(r.a)}" x2="${xs(r.dMax + 20)}" y2="${ys(r.a + r.b * (r.dMax + 20))}" stroke="var(--acc)" stroke-width="1"/>`;
  const selInf = selected?.inference;
  r.points.forEach((p, i) => {
    const ly = Math.log10(p.mw);
    const fitY = ys(r.a + r.b * p.d);
    s += `<line x1="${xs(p.d)}" y1="${ys(ly)}" x2="${xs(p.d)}" y2="${fitY}" stroke="var(--warn)" stroke-width="1.5"/>`;
    s += `<circle cx="${xs(p.d)}" cy="${ys(ly)}" r="3.5" fill="var(--ok)"><title>${p.mw} bp @ ${p.d.toFixed(1)}px</title></circle>`;
    s += `<text x="${xs(p.d) - 8}" y="${ys(ly) - 6}" fill="var(--ok)">${p.mw}</text>`;
    void i;
  });
  if (selInf) {
    const d = selInf.dEff;
    const inRegion = d >= r.dMin && d <= r.dMax;
    s += `<line x1="${xs(d)}" y1="10" x2="${xs(d)}" y2="${Hpx - pad}" stroke="${inRegion ? "var(--acc)" : "var(--bad)"}" stroke-dasharray="4 3" stroke-width="2"/>`;
    // interpolation segment: bracketing ladder points
    const sorted = [...r.points].sort((p, q) => p.d - q.d);
    const lo = [...sorted].reverse().find((p) => p.d <= d);
    const hi = sorted.find((p) => p.d >= d);
    if (lo && hi) {
      s += `<line x1="${xs(lo.d)}" y1="${ys(r.a + r.b * lo.d)}" x2="${xs(hi.d)}" y2="${ys(r.a + r.b * hi.d)}" stroke="var(--bad)" stroke-width="4" opacity="${flash ? 1 : 0.6}"/>`;
      s += `<text x="${xs(d) + 4}" y="${Hpx - pad - 4}" fill="var(--acc)">d_eff=${d.toFixed(1)}px → ${mwText(selInf)}</text>`;
    } else {
      s += `<text x="${xs(Math.min(d, r.dMax + 10)) - 60}" y="${Hpx - pad - 4}" fill="var(--bad)">超出有效区间 → 只能给区间</text>`;
    }
  }
  s += `<text x="4" y="${ys(4)}" fill="var(--dim)">10⁴</text><text x="4" y="${ys(3)}" fill="var(--dim)">10³ bp</text>`;
  svg.setAttribute("viewBox", `0 0 ${Wpx} ${Hpx}`);
  svg.innerHTML = s;
  $("#resid").textContent = "拟合残差 (log10 bp): " + r.residuals.map((x) => x.toFixed(3)).join("  ");
}

function renderEvents() {
  const el = $("#events");
  el.innerHTML = view.events.map((e) => {
    const p = typeof e.payload === "object" ? JSON.stringify(e.payload).slice(0, 90) : "";
    return `<div data-seq="${e.seq}"><span class="muted">#${e.seq}</span> <b>[${e.branchId}]</b> ${e.kind} <span class="muted">${p}</span></div>`;
  }).join("");
  el.querySelectorAll("div").forEach((d) => d.addEventListener("click", () => replay(Number((d as HTMLElement).dataset.seq))));
}

async function replay(seq: number) {
  const { body } = await api(`/api/replay/${seq}`);
  const banner = $("#replay-banner");
  banner.style.display = "block";
  const byKind: Record<string, number> = {};
  for (const d of body.derived) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  banner.innerHTML = `正在查看历史事件 #${seq} · 当时可见的派生结果: ${Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join(", ")} · 历史不被最新计算覆盖 <a id="back-now">返回当前</a>`;
  $("#back-now").addEventListener("click", () => { banner.style.display = "none"; });
}

function showDiagnostics(diags: { code: string; message: string; path: string; severity: string }[], prefix = "") {
  $("#diag").innerHTML = diags.length
    ? diags.map((d) => `[${d.severity}] ${d.code} @ ${d.path}: ${d.message}`).join("\n")
    : "无";
  if (prefix) $("#diag").textContent = prefix + "\n" + $("#diag").textContent;
}

async function reload() {
  view = (await api("/api/view")).body as View;
  state = (await api("/api/state")).body as State;
  $("#digest").textContent = `project digest ${state.digest.slice(4, 20)}`;
  renderGel(); renderRuler(); renderEvents(); renderDetail();
}

async function compute() {
  const r = await api("/api/compute", { method: "POST" });
  if (r.status !== 200) showDiagnostics(r.body.diagnostics ?? [], `计算失败 (${r.body.kind ?? r.status})`);
  else showDiagnostics(r.body.diagnostics ?? []);
  await reload();
}

// ---- 反例档案场景 ----
async function scenario(id: string) {
  const mats = state.materials;
  const ladderMat = mats.find((m) => m.kind === "ladder-nominal")!;
  const srcChange = async (materialId: string, payload: unknown) => {
    const r = await api("/api/source-change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ materialId, payload }) });
    if (r.status !== 200) { showDiagnostics(r.body.diagnostics ?? []); return null; }
    return r.body as { newMaterialId: string; superseded: string[] };
  };
  switch (id) {
    case "rotated": {
      const cap = mats.find((m) => m.kind === "capture-meta")!;
      showDiagnostics([], `拍摄方向 ${(cap.payload as any).orientationDeg}° · 曝光 ${(cap.payload as any).exposure?.raw} · 原图按 raw 像素保留,派生层在 image-norm 坐标系计算`);
      break;
    }
    case "smile": {
      const ev = view.events.find((e) => e.kind === "judgment:smile-local-ruler");
      showDiagnostics([], ev ? `机器可读取判断: ${(ev.payload as any).rule}\n有效区域: ${JSON.stringify((ev.payload as any).validRegion)}` : "未找到判断事件");
      break;
    }
    case "ladder-gap": {
      const p = JSON.parse(JSON.stringify(ladderMat.payload));
      p.sizes.splice(3, 1); // 去掉 5000bp 标称值
      const r = await srcChange(ladderMat.id, p);
      if (r) { await compute(); showDiagnostics([], `ladder 缺带:源数据已修订,受影响派生 ${r.superseded.length} 个已局部失效`); }
      break;
    }
    case "saturated": {
      selected = view.bands.find((b) => b.reasons.includes("saturated")) ?? null;
      renderGel(); renderDetail(); renderRuler();
      showDiagnostics([], "饱和条带只能标为候选(candidate),见条带详情与 judgment:degraded-band-evidence 事件");
      break;
    }
    case "overlap": {
      selected = view.bands.find((b) => b.reasons.includes("overlap")) ?? null;
      renderGel(); renderDetail(); renderRuler();
      showDiagnostics([], "重叠条带只能标为区间/候选,保留全部合法候选");
      break;
    }
    case "nonmono": {
      const p = JSON.parse(JSON.stringify(ladderMat.payload));
      const s = p.sizes; [s[2], s[6]] = [s[6], s[2]]; // 交换两个标称值 → 非单调
      const r = await srcChange(ladderMat.id, p);
      if (r) {
        const c = await api("/api/compute", { method: "POST" });
        showDiagnostics(c.body.diagnostics ?? [], `非单调标尺 → ${c.body.kind ?? "ok"}(与格式损坏、预算耗尽是三种不同结果)`);
        await reload();
      }
      break;
    }
    case "local-invalidation": {
      const laneMat = mats.find((m) => m.kind === "lane-boundary" && (m.payload as any).laneId === "lane-3")!;
      const p = JSON.parse(JSON.stringify(laneMat.payload));
      p.points = p.points.map((pt: any) => ({ x: pt.x + 3, y: pt.y }));
      const r = await srcChange(laneMat.id, p);
      if (r) {
        await compute();
        showDiagnostics([], `修订后局部失效:仅 lane-3 依赖锥失效 (${r.superseded.length} 个派生结果),其余泳道身份保持不变`);
      }
      break;
    }
    case "reset": {
      await api("/api/reset", { method: "POST" });
      selected = null;
      await reload();
      showDiagnostics([], "已恢复基线案例包");
      break;
    }
  }
}

// ---- 工作流按钮 ----
$("#btn-import").addEventListener("click", async () => { await api("/api/reset", { method: "POST" }); selected = null; await reload(); });
$("#btn-compute").addEventListener("click", compute);
$("#btn-save").addEventListener("click", async () => {
  const s = (await api("/api/state")).body as State;
  showDiagnostics([], `已保存到本地 SQLite · digest ${s.digest.slice(0, 28)}…`);
});
$("#btn-export").addEventListener("click", async () => {
  const { body } = await api("/api/export");
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gel-ruler-bundle.json";
  a.click();
  await reload();
});
$("#btn-reopen").addEventListener("click", () => $("#file-reopen").click());
$("#file-reopen").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const text = await f.text();
  const r = await api("/api/import", { method: "POST", body: text });
  if (r.status !== 200) showDiagnostics(r.body.diagnostics ?? [], `导入失败 (${r.body.kind})`);
  else showDiagnostics([], `导入完成 · 身份/顺序/来源关系保持 (matched=${r.body.matched})`);
  await reload();
});
document.querySelectorAll(".scenario").forEach((b) => b.addEventListener("click", () => scenario((b as HTMLElement).dataset.sc!)));
for (const id of ["ov-image", "ov-lanes", "ov-bands"]) $(`#${id}`).addEventListener("change", renderGel);

await reload();
export {};
