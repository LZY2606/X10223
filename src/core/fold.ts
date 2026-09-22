import type {
  BandCenterMaterial,
  CalibrationSegment,
  DecisionType,
  Diagnostic,
  ExposureMaterial,
  GelEvent,
  LadderAssignment,
  LadderMaterial,
  LaneBoundaryMaterial,
  MwCandidate,
  OrientationMaterial,
  ParamSet,
  RawImageMaterial,
} from '../shared/types';

/**
 * 纯事件折叠器：无 I/O，测试直接调用。
 * 回到任意旧事件 = 折叠到该 branchSeq；看到的是当时的依赖版本与可见结论。
 */
export interface TipState {
  eventId: string | null;
  branchSeq: number;
  logicalClock: number;
  image?: RawImageMaterial;
  orientation?: OrientationMaterial;
  exposure?: ExposureMaterial;
  ladder?: LadderMaterial;
  lanes: Record<string, LaneBoundaryMaterial>;
  laneVersions: Record<string, LaneBoundaryMaterial[]>;
  bands: Record<string, BandCenterMaterial>;
  bandVersions: Record<string, BandCenterMaterial[]>;
  candidates: Record<string, MwCandidate>;
  candidateHistory: MwCandidate[];
  assignments: Record<string, LadderAssignment>;
  segments: Record<string, CalibrationSegment>;
  params: Record<string, ParamSet>;
  decisions: { eventId: string; type: DecisionType; subjectId: string; note?: string }[];
  diagnostics: Diagnostic[];
  conflicts: { subjectId: string; eventIds: string[]; note?: string }[];
}

export function emptyTip(): TipState {
  return {
    eventId: null,
    branchSeq: 0,
    logicalClock: 0,
    lanes: {},
    laneVersions: {},
    bands: {},
    bandVersions: {},
    candidates: {},
    candidateHistory: [],
    assignments: {},
    segments: {},
    params: {},
    decisions: [],
    diagnostics: [],
    conflicts: [],
  };
}

function recordConflict(tip: TipState, subjectId: string, eventId: string, note?: string) {
  const existing = tip.conflicts.find((c) => c.subjectId === subjectId);
  if (existing) {
    if (!existing.eventIds.includes(eventId)) existing.eventIds.push(eventId);
    if (note) existing.note = note;
  } else {
    tip.conflicts.push({ subjectId, eventIds: [eventId], note });
  }
}

/** 局部失效：只把声明了父级依赖的候选标 invalidated，其他 lane 的结论不动 */
function invalidateByParents(tip: TipState, parentSubjectIds: string[], byEventId: string) {
  if (parentSubjectIds.length === 0) return;
  for (const candidate of Object.values(tip.candidates)) {
    if (candidate.status === 'invalidated') continue;
    const hits = candidate.parents.some((p) => parentSubjectIds.includes(p));
    if (hits) {
      candidate.status = 'invalidated';
      candidate.invalidatedBy = byEventId;
    }
  }
}

export function applyEvent(tip: TipState, event: GelEvent): TipState {
  const next: TipState = {
    ...tip,
    lanes: { ...tip.lanes },
    laneVersions: Object.fromEntries(Object.entries(tip.laneVersions).map(([k, v]) => [k, [...v]])),
    bands: { ...tip.bands },
    bandVersions: Object.fromEntries(Object.entries(tip.bandVersions).map(([k, v]) => [k, [...v]])),
    candidates: { ...tip.candidates },
    candidateHistory: [...tip.candidateHistory],
    assignments: { ...tip.assignments },
    segments: { ...tip.segments },
    params: { ...tip.params },
    decisions: [...tip.decisions],
    diagnostics: [...tip.diagnostics],
    conflicts: tip.conflicts.map((c) => ({ ...c, eventIds: [...c.eventIds] })),
  };
  next.eventId = event.eventId;
  next.branchSeq = event.branchSeq;
  next.logicalClock = event.logicalClock;

  switch (event.type) {
    case 'projectCreated':
      break;
    case 'branchCreated':
      break;
    case 'materialAdded': {
      const m = event.payload.material;
      if (m.kind === 'rawImage') next.image = m;
      else if (m.kind === 'orientation') next.orientation = m;
      else if (m.kind === 'exposure') next.exposure = m;
      else if (m.kind === 'ladder') next.ladder = m;
      else if (m.kind === 'laneBoundary') {
        next.lanes[m.laneId] = m;
        next.laneVersions[m.laneId] = [...(next.laneVersions[m.laneId] ?? []), m];
      } else if (m.kind === 'bandCenter') {
        next.bands[m.bandId] = m;
        next.bandVersions[m.bandId] = [...(next.bandVersions[m.bandId] ?? []), m];
      }
      break;
    }
    case 'materialSuperseded': {
      const m = event.payload.newMaterial;
      if (m.kind === 'rawImage') next.image = m;
      else if (m.kind === 'orientation') next.orientation = m;
      else if (m.kind === 'exposure') next.exposure = m;
      else if (m.kind === 'ladder') next.ladder = m;
      else if (m.kind === 'laneBoundary') {
        next.lanes[m.laneId] = m;
        next.laneVersions[m.laneId] = [...(next.laneVersions[m.laneId] ?? []), m];
        invalidateByParents(next, [m.laneId], event.eventId);
      } else if (m.kind === 'bandCenter') {
        next.bands[m.bandId] = m;
        next.bandVersions[m.bandId] = [...(next.bandVersions[m.bandId] ?? []), m];
        invalidateByParents(next, [m.bandId, m.laneId], event.eventId);
      }
      break;
    }
    case 'autoAnalyzed':
      break;
    case 'decisionRecorded': {
      const { decision, subjectId, note, paramSet, value } = event.payload;
      next.decisions.push({ eventId: event.eventId, type: decision, subjectId, note });
      if (paramSet) next.params[paramSet.version] = paramSet;
      // 同主体互斥人工决定 -> 冲突，二者都保留，不以后者覆盖
      const conflicting = next.decisions.filter(
        (d) =>
          d.subjectId === subjectId &&
          d.eventId !== event.eventId &&
          ((d.type === 'acceptMwCandidate' && decision === 'rejectBand') ||
            (d.type === 'rejectBand' && decision === 'acceptMwCandidate') ||
            (d.type === 'acceptMwCandidate' && decision === 'overrideMw') ||
            (d.type === 'overrideMw' && decision === 'acceptMwCandidate') ||
            (d.type === 'overrideMw' && decision === 'rejectBand'))
      );
      if (conflicting.length > 0) {
        recordConflict(next, subjectId, event.eventId, note ?? '互相冲突的人工决定，两个结果均保留');
        for (const c of conflicting) recordConflict(next, subjectId, c.eventId);
      }
      if (decision === 'acceptMwCandidate') {
        const cand = next.candidates[subjectId];
        if (cand && cand.status !== 'invalidated' && cand.status !== 'ambiguous') {
          // 区间/候选证据下也可以人工接受，但保留原始候选与诊断
          next.candidates[subjectId] = { ...cand, status: 'accepted' };
        }
      } else if (decision === 'rejectBand') {
        const cand = next.candidates[subjectId];
        if (cand) next.candidates[subjectId] = { ...cand, status: 'rejected' };
      } else if (decision === 'overrideMw' && value) {
        const cand = next.candidates[subjectId];
        if (cand) {
          next.candidates[subjectId] = {
            ...cand,
            status: 'accepted',
            quantity: value,
            interval: undefined,
          };
        }
      }
      break;
    }
    case 'derivationEmitted': {
      const rec = event.payload.record as { candidateId?: string; assignmentId?: string; segmentId?: string };
      if (event.payload.kind === 'mwCandidate') {
        const c = rec as unknown as MwCandidate;
        next.candidates[c.candidateId] = c;
        next.candidateHistory.push(c);
      } else if (event.payload.kind === 'ladderAssignment') {
        const a = rec as unknown as LadderAssignment;
        next.assignments[a.assignmentId] = a;
      } else if (event.payload.kind === 'calibrationSegment') {
        const s = rec as unknown as CalibrationSegment;
        next.segments[s.segmentId] = s;
      } else if (event.payload.kind === 'invalidation') {
        const r = rec as unknown as { candidateIds: string[]; reason: string };
        for (const id of r.candidateIds) {
          const c = next.candidates[id];
          if (c) next.candidates[id] = { ...c, status: 'invalidated', invalidatedBy: event.eventId };
        }
      }
      break;
    }
    case 'halfWriteDetected':
      next.diagnostics.push({
        code: 'HALF_WRITE_RECOVERED',
        severity: 'warning',
        message: `检测到半写暂存（${event.payload.bytesSeen} 字节）：${event.payload.detail}；已回滚，现有库未受污染`,
        position: { path: event.payload.stagingUri },
      });
      break;
  }
  return next;
}

/** 折叠到指定事件（不含该事件之后），用于“回到旧事件恢复当时结论” */
export function foldBranch(events: GelEvent[], upToBranchSeq?: number): TipState {
  let tip = emptyTip();
  const sorted = [...events].sort((a, b) => a.branchSeq - b.branchSeq);
  for (const event of sorted) {
    if (upToBranchSeq !== undefined && event.branchSeq > upToBranchSeq) break;
    tip = applyEvent(tip, event);
  }
  return tip;
}

/**
 * 分支重放：分支从 forkPointEventId 起应用自己的事件；
 * fork 点之前取父分支事件（父分支的事件身份原样保留）。
 */
export function foldBranchWithParent(args: {
  projectEvents: GelEvent[];
  branch: string;
  parentBranch: string | null;
  forkPointEventId: string | null;
  upToBranchSeq?: number;
}): TipState {
  const { projectEvents, branch, parentBranch, forkPointEventId, upToBranchSeq } = args;
  let tip = emptyTip();
  if (parentBranch && forkPointEventId) {
    const parentEvents = projectEvents
      .filter((e) => e.branch === parentBranch)
      .sort((a, b) => a.branchSeq - b.branchSeq);
    const idx = parentEvents.findIndex((e) => e.eventId === forkPointEventId);
    tip = foldBranch(parentEvents.slice(0, idx + 1));
  }
  const own = projectEvents
    .filter((e) => e.branch === branch)
    .sort((a, b) => a.branchSeq - b.branchSeq);
  for (const event of own) {
    if (upToBranchSeq !== undefined && event.branchSeq > upToBranchSeq) break;
    tip = applyEvent(tip, event);
  }
  return tip;
}
