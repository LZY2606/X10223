import type {
  BandCenterMaterial,
  BudgetReport,
  Diagnostic,
  ProjectDerivation,
  ProjectState,
} from './types.js';
import { canonicalJSON, contentId } from './ids.js';
import { RULE_VERSION } from './events.js';
import { checkInputs } from './diagnose.js';
import { materialHash } from './materials.js';
import { GrayRaster } from './raster.js';
import { BudgetExhaustedError } from './errors.js';
import { toAnalyzeFrame } from './analyze-frame.js';
import { deriveLane, type LaneRuntime } from './derive-lanes.js';

export interface DeriveResult {
  derivation: ProjectDerivation | null;
  diagnostics: Diagnostic[];
  outcome: 'ok' | 'incomplete' | 'semantic-unsolvable';
}

class Budget {
  used = 0;
  constructor(readonly limit: number) {}
  tick(n = 1): void {
    this.used += n;
    if (this.used > this.limit) throw new BudgetExhaustedError(this.used, this.limit);
  }
}

export function derive(
  state: ProjectState,
  raster: GrayRaster | null,
  rasterFor: (sha: string) => GrayRaster | null,
  budgetLimit = 2_000_000,
  now = 0,
): DeriveResult {
  const checked = checkInputs(state, (sha) => rasterFor(sha) !== null);
  if (checked.diagnostics.some((d) => d.severity === 'error')) {
    return { derivation: null, diagnostics: checked.diagnostics, outcome: 'incomplete' };
  }

  const image = checked.image!;
  const orientation = checked.orientation!;
  const exposure = checked.exposure!;
  const lanesMat = checked.lanes!;
  const ladderMat = checked.ladder!;
  const budget = new Budget(budgetLimit);

  const baseRaster = raster ?? rasterFor(image.pngSha256);
  if (!baseRaster) {
    return {
      derivation: null,
      diagnostics: [
        {
          code: 'missing-raster-bytes',
          severity: 'error',
          message: '图像像素字节在计算时不可用',
          at: { path: 'materials.gel-image', materialId: image.id },
        },
      ],
      outcome: 'incomplete',
    };
  }
  budget.tick(baseRaster.data.length);
  const cw = orientation.rotateClockwise.value;
  const analyzeRaster = cw === 0 ? baseRaster : baseRaster.rotateCW(cw);
  budget.tick(analyzeRaster.data.length);

  const frame = toAnalyzeFrame(
    lanesMat.lanes,
    checked.bands,
    image.width.value,
    image.height.value,
    cw,
  );

  const allDiagnostics: Diagnostic[] = [...checked.diagnostics];
  const lanes = frame.lanes.map((laneSpec) => {
    const rt: LaneRuntime = {
      state,
      exposure,
      ladderMat,
      lane: laneSpec,
      sourceLaneId: lanesMat.lanes.find((l) => l.laneId === laneSpec.laneId)!.laneId,
      bandsMat: checked.bands[laneSpec.laneId] as BandCenterMaterial,
      analyzeCenters: frame.bandCentersAnalyze[laneSpec.laneId] ?? [],
      analyzeRaster,
      budgetTick: (n: number) => budget.tick(n),
    };
    const ld = deriveLane(rt);
    allDiagnostics.push(...ld.calibration.diagnostics, ...ld.bands.flatMap((b) => b.diagnostics));
    return ld;
  });

  applyDecisions(state, lanes);

  const materialHashes: Record<string, string> = {};
  for (const m of Object.values(state.materials)) materialHashes[m.id] = materialHash(m);

  const body = {
    projectId: state.projectId,
    branchId: state.branchId,
    headEventId: state.headEventId ?? '',
    ruleVersion: RULE_VERSION,
    inputSummary: { materialHashes, parameterVersion: state.parameters.id, imageId: image.id },
    lanes,
  };
  const derivationId = contentId('deriv', canonicalJSON(body));
  const report: BudgetReport = { limitOps: budget.limit, usedOps: budget.used, exhausted: false };

  return {
    derivation: { ...body, derivationId, diagnostics: allDiagnostics, computedAt: now, budget: report },
    diagnostics: allDiagnostics,
    outcome: 'ok',
  };
}

function applyDecisions(state: ProjectState, lanes: ReturnType<typeof deriveLane>[]): void {
  const byLane = new Map(lanes.map((l) => [l.lane.laneId, l]));
  for (const ev of state.events) {
    if (ev.type !== 'decision') continue;
    const p = ev.payload as {
      kind: 'accept' | 'reject' | 'adjust';
      targetRef: { kind: string; laneId?: string; bandId?: string };
      selectedCandidateId?: string;
      note: string;
    };
    if (p.targetRef.kind === 'band' && p.targetRef.laneId && p.targetRef.bandId) {
      const lane = byLane.get(p.targetRef.laneId);
      const band = lane?.bands.find((b) => b.bandId === p.targetRef.bandId);
      if (band) {
        band.decision = {
          kind: p.kind,
          selectedCandidateId: p.selectedCandidateId,
          note: p.note,
        };
        if (p.kind === 'accept' && p.selectedCandidateId) {
          const c = band.candidates.find((x) => x.candidateId === p.selectedCandidateId);
          if (c) band.acceptedBp = c.bp;
        }
      }
    }
  }
}
