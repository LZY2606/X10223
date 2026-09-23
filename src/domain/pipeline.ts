import type { Diagnostic, Result } from "./diagnostics.ts";
import { ok, fail, diag } from "./diagnostics.ts";
import type { Quantity } from "./units.ts";
import { parseQuantity, qty } from "./units.ts";
import type { Pt, LaneCurve } from "./geometry.ts";
import { rotatePoint, rotatedSize, fitLaneCurve } from "./geometry.ts";
import type { Ruler, LadderPoint } from "./ruler.ts";
import { fitRuler } from "./ruler.ts";
import type { BandEvidence, BandClassification } from "./bands.ts";
import { classifyBand } from "./bands.ts";
import type { Inference } from "./infer.ts";
import { inferMw } from "./infer.ts";
import type { Material, Derived, EventRecord } from "./model.ts";
import { PARAM_VERSION, materialId, derivedId, inputDigest, makeEvent, stableSort } from "./model.ts";

export interface Budget { maxOps: number; }

export class BudgetExceeded extends Error {}

export function spend(budget: Budget, ops: number): void {
  budget.maxOps -= ops;
  if (budget.maxOps < 0) throw new BudgetExceeded("resource budget exhausted");
}

export interface CasepackImage {
  file: string;
  width: number;
  height: number;
}

export interface Casepack {
  name: string;
  image: CasepackImage;
  capture: { orientationDeg: 0 | 90 | 180 | 270; exposureRaw: string };
  ladder: { laneIndex: number; sizesRaw: string[] };
  lanes: { id: string; boundaryRaw: { x: number; y: number }[] }[];
  bands: { id: string; laneId: string; x: number; y: number; maxIntensity: number; trailingScore: number }[];
  saturationThreshold: number;
}

export interface Ingested {
  materials: Material[];
  captureMatId: string;
  ladderMatId: string;
  capture: { orientationDeg: 0 | 90 | 180 | 270; exposure: Quantity | null };
  image: CasepackImage;
  ladderSizes: (Quantity | null)[];
  lanes: { id: string; materialId: string; boundaryNorm: Pt[] }[];
  bands: { ev: BandEvidence; materialId: string }[];
  events: EventRecord[];
}

/** Ingest a casepack into immutable materials. Incomplete input -> positioned diagnostics, never silent defaults. */
export function ingestCasepack(pack: Casepack, budget: Budget, seq0: number): Result<Ingested> {
  const diagnostics: Diagnostic[] = [];
  try {
    spend(budget, 10);
    const events: EventRecord[] = [];
    let seq = seq0;
    const materials: Material[] = [];
    const addMat = (kind: Material["kind"], payload: unknown): Material => {
      const m: Material = { id: materialId(kind, payload), kind, version: 1, supersedes: null, payload, createdByEvent: "" };
      materials.push(m);
      return m;
    };

    if (!pack.image || !pack.capture || !pack.ladder || !pack.lanes || !pack.bands) {
      return fail("format_corrupt", [diag("casepack-incomplete", "casepack missing required sections", "/")]);
    }

    const imgMat = addMat("gel-image", { file: pack.image.file, width: pack.image.width, height: pack.image.height });
    const exposure = parseQuantity(pack.capture.exposureRaw, "kV*h", "/capture/exposure");
    diagnostics.push(...exposure.diagnostics);
    const capMat = addMat("capture-meta", {
      orientationDeg: pack.capture.orientationDeg,
      exposure: exposure.quantity ?? { raw: pack.capture.exposureRaw },
    });

    const ladderSizes: (Quantity | null)[] = [];
    pack.ladder.sizesRaw.forEach((raw, i) => {
      const q = parseQuantity(raw, "bp", `/ladder/sizes/${i}`);
      diagnostics.push(...q.diagnostics);
      ladderSizes.push(q.quantity);
    });
    const ladMat = addMat("ladder-nominal", { laneIndex: pack.ladder.laneIndex, sizes: ladderSizes.map((q, i) => q ?? { raw: pack.ladder.sizesRaw[i] }) });

    const deg = pack.capture.orientationDeg;
    const { w: W, h: H } = { w: pack.image.width, h: pack.image.height };
    const lanes: Ingested["lanes"] = [];
    pack.lanes.forEach((lane, li) => {
      spend(budget, 1);
      if (!lane.boundaryRaw || lane.boundaryRaw.length < 2) {
        diagnostics.push(diag("lane-boundary-missing", `lane ${lane.id} has <2 boundary points`, `/lanes/${li}`));
        return;
      }
      const boundaryRaw = lane.boundaryRaw.map((p) => qty(`${p.x}px`, p.x, "px", "image-raw") && { x: p.x, y: p.y });
      const mat = addMat("lane-boundary", { laneId: lane.id, points: lane.boundaryRaw, basis: "image-raw" });
      void boundaryRaw;
      const boundaryNorm = lane.boundaryRaw.map((p) => rotatePoint(p, deg, W, H));
      lanes.push({ id: lane.id, materialId: mat.id, boundaryNorm });
    });

    const bands: Ingested["bands"] = [];
    pack.bands.forEach((b, bi) => {
      spend(budget, 1);
      if (typeof b.x !== "number" || typeof b.y !== "number") {
        diagnostics.push(diag("band-center-missing", `band ${b.id} lacks pixel center`, `/bands/${bi}`));
        return;
      }
      const mat = addMat("band-center", { bandId: b.id, laneId: b.laneId, x: b.x, y: b.y, basis: "image-raw", maxIntensity: b.maxIntensity, trailingScore: b.trailingScore });
      bands.push({
        materialId: mat.id,
        ev: {
          id: b.id, laneId: b.laneId,
          center: qty(`${b.y}px`, b.y, "px", "image-raw"),
          centerX: qty(`${b.x}px`, b.x, "px", "image-raw"),
          maxIntensity: b.maxIntensity,
          saturationThreshold: pack.saturationThreshold,
          trailingScore: b.trailingScore,
        },
      });
    });

    if (diagnostics.some((d) => d.severity === "error")) {
      return fail("format_corrupt", diagnostics);
    }
    const ev = makeEvent(seq++, "main", "import", { casepack: pack.name, materials: materials.map((m) => m.id) }, []);
    events.push(ev);
    for (const m of materials) m.createdByEvent = ev.id;
    void rotatedSize;
    return ok({ materials, captureMatId: capMat.id, ladderMatId: ladMat.id, capture: { orientationDeg: deg, exposure: exposure.quantity }, image: pack.image, ladderSizes, lanes, bands, events }, diagnostics);
  } catch (e) {
    if (e instanceof BudgetExceeded) return fail("budget_exhausted", [diag("budget-exhausted", e.message, "/")]);
    throw e;
  }
}

export interface Computed {
  derived: Derived[];
  events: EventRecord[];
  inferences: Inference[];
  rulers: { laneId: string; ruler: Ruler }[];
  curves: { laneId: string; curve: LaneCurve }[];
}

/** Compute derived layer: lane curves, local rulers, MW inferences. Emits machine-readable judgment events. */
export function computeDerived(ing: Ingested, budget: Budget, seq0: number, branchId = "main"): Result<Computed> {
  const diagnostics: Diagnostic[] = [];
  try {
    const derived: Derived[] = [];
    const events: EventRecord[] = [];
    let seq = seq0;
    const curves: Computed["curves"] = [];
    const rulers: Computed["rulers"] = [];
    const inferences: Inference[] = [];
    const deg = ing.capture.orientationDeg;
    const W = ing.image.width, H = ing.image.height;

    const addDerived = (kind: Derived["kind"], parents: string[], payload: unknown): Derived => {
      const dig = inputDigest(parents, PARAM_VERSION);
      const d: Derived = { id: derivedId(kind, dig), kind, paramVersion: PARAM_VERSION, inputDigest: dig, parents: [...parents].sort(), status: "current", payload };
      derived.push(d);
      return d;
    };

    // lane curves
    const curveByLane = new Map<string, { curve: LaneCurve; drv: Derived }>();
    for (const lane of ing.lanes) {
      spend(budget, 5);
      const curve = fitLaneCurve(lane.boundaryNorm);
      const drv = addDerived("lane-curve", [lane.materialId, ing.captureMatId], { laneId: lane.id, curve, basis: "image-norm", unit: "px" });
      curveByLane.set(lane.id, { curve, drv });
      curves.push({ laneId: lane.id, curve });
    }

    // ladder ruler (local, with validity region)
    const ladderLane = ing.lanes[0];
    const ladderPoints: LadderPoint[] = [];
    const ladderBands = ing.bands.filter((b) => b.ev.laneId === ladderLane.id);
    const sizes = ing.ladderSizes;
    if (ladderBands.length !== sizes.filter((s) => s !== null).length) {
      diagnostics.push(diag("ladder-band-missing",
        `ladder declares ${sizes.length} nominal sizes but ${ladderBands.length} bands are visible; pairing first ${Math.min(ladderBands.length, sizes.length)} in order`,
        "/ladder", "warning"));
    }
    const pairCount = Math.min(ladderBands.length, sizes.length);
    const sortedLadderBands = [...ladderBands].sort((a, b) => {
      const ya = rotatePoint({ x: a.ev.centerX.value, y: a.ev.center.value }, deg, W, H).y;
      const yb = rotatePoint({ x: b.ev.centerX.value, y: b.ev.center.value }, deg, W, H).y;
      return ya - yb;
    });
    for (let i = 0; i < pairCount; i++) {
      const q = sizes[i];
      if (!q) continue;
      const p = rotatePoint({ x: sortedLadderBands[i].ev.centerX.value, y: sortedLadderBands[i].ev.center.value }, deg, W, H);
      const c = curveByLane.get(ladderLane.id)!.curve;
      const corr = c.c2 * p.y * p.y + c.c1 * p.y;
      ladderPoints.push({ d: p.y - corr, mw: q.value });
    }
    const rulerRes = fitRuler(ladderPoints, "/ladder");
    if (!rulerRes.ok) {
      return { ok: false, kind: rulerRes.kind, diagnostics: [...diagnostics, ...rulerRes.diagnostics] } as Result<Computed>;
    }
    const ruler = rulerRes.value;
    const rulerDrv = addDerived("ruler", [ing.ladderMatId, ing.captureMatId, ladderLane.materialId, ...sortedLadderBands.slice(0, pairCount).map((b) => b.materialId)],
      { laneId: ladderLane.id, a: ruler.a, b: ruler.b, dMin: ruler.dMin, dMax: ruler.dMax, unit: "bp", basis: "image-norm",
        points: ruler.points, residuals: ruler.residuals });
    rulers.push({ laneId: ladderLane.id, ruler });

    // machine-readable judgment: smile curvature => local ruler with validity region
    const curved = curves.filter((c) => Math.abs(c.curve.c2) > 1e-6 || Math.abs(c.curve.c1) > 1e-6);
    if (curved.length > 0) {
      events.push(makeEvent(seq++, branchId, "judgment:smile-local-ruler", {
        rule: "smile curvature: same height != same molecular weight; local ruler must carry a validity region",
        lanes: curved.map((c) => c.laneId),
        validRegion: { dMin: ruler.dMin, dMax: ruler.dMax, unit: "px", basis: "image-norm" },
      }, [rulerDrv.id, ...curved.map((c) => curveByLane.get(c.laneId)!.drv.id)]));
    }

    // per-band classification + inference (classification happens in the NORMALIZED frame;
    // raw pixel coordinates stay on the materials as provenance)
    const normOf = (b: { ev: BandEvidence }) => rotatePoint({ x: b.ev.centerX.value, y: b.ev.center.value }, deg, W, H);
    const allNorm = ing.bands.map((b) => ({ ...b.ev, center: { ...b.ev.center, value: normOf(b).y, basis: "image-norm" as const } }));
    for (const b of ing.bands) {
      spend(budget, 3);
      const laneEntry = curveByLane.get(b.ev.laneId);
      if (!laneEntry) {
        diagnostics.push(diag("band-lane-missing", `band ${b.ev.id} references unknown lane ${b.ev.laneId}`, `/bands/${b.ev.id}`));
        continue;
      }
      const evNorm = allNorm.find((e) => e.id === b.ev.id)!;
      const cls: BandClassification = classifyBand(evNorm, allNorm);
      if (cls.status !== "accepted") {
        events.push(makeEvent(seq++, branchId, "judgment:degraded-band-evidence", {
          rule: "saturated, trailing or overlapping bands may only be candidate or interval",
          bandId: b.ev.id, status: cls.status, reasons: cls.reasons, overlapGroup: cls.overlapGroup,
        }, [b.materialId]));
      }
      const pNorm = normOf(b);
      const inf = inferMw(evNorm, cls, laneEntry.curve, ruler, pNorm.y);
      inferences.push(inf);
      addDerived("inference", [b.materialId, laneEntry.drv.id, rulerDrv.id], inf);
    }

    events.push(makeEvent(seq++, branchId, "compute", { paramVersion: PARAM_VERSION, derived: derived.map((d) => d.id) }, derived.map((d) => d.id)));
    return ok({ derived: stableSort(derived), events, inferences, rulers, curves }, diagnostics);
  } catch (e) {
    if (e instanceof BudgetExceeded) return fail("budget_exhausted", [diag("budget-exhausted", e.message, "/")]);
    throw e;
  }
}
