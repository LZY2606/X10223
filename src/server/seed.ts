/**
 * 离线案例包装配（服务端启动自动装载，无需账号/云/额外配置）：
 *
 * 主叙事项目 prj-gel-review：
 *   基线（全部像素级来源）-> 自动候选 -> 人工参数修订 -> 只影响局部依赖的源改动（移动一条带）
 *   -> 互相冲突的人工决定（接受/否定都保留）。
 *
 * 反例档案：每个情形一个项目（main 分支），并各自 fork 出一个反例分支，
 * 分支相对基线只改动一个直接来源；采纳与未采纳结果都进入 counterexamples 索引。
 */
import type { GelService } from './service.js';
import {
  buildScenario,
  type ScenarioKind
} from '../core/casepack/scenarios.js';
import type { CounterexampleEntry } from '../core/types.js';

export const BASELINE_PROJECT = 'prj-gel-review';

export const COUNTEREXAMPLE_KINDS: {
  kind: ScenarioKind;
  projectId: string;
  changedSource: string;
  branchName: string;
}[] = [
  { kind: 'rotation', projectId: 'prj-ce-rotation', changedSource: 'rawImage.orientation', branchName: '旋转图像' },
  { kind: 'smile', projectId: 'prj-ce-smile', changedSource: 'laneGeometry', branchName: '微笑弯曲' },
  { kind: 'ladder-missing', projectId: 'prj-ce-missing', changedSource: 'ladderSpec.band#5', branchName: 'ladder 缺带' },
  { kind: 'saturation', projectId: 'prj-ce-saturation', changedSource: 'exposure.level', branchName: '饱和区' },
  { kind: 'overlap', projectId: 'prj-ce-overlap', changedSource: 'band.center.lane-s1-b4', branchName: '两条带重叠' },
  { kind: 'nonmonotonic', projectId: 'prj-ce-nonmonotonic', changedSource: 'ladderSpec.nominal.swap', branchName: '非单调标尺' },
  {
    kind: 'revision-local-invalidation',
    projectId: 'prj-ce-local-invalid',
    changedSource: 'band.center.lane-s2-b3',
    branchName: '修订后局部失效'
  }
];

export interface SeedReport {
  projects: { id: string; name: string; kind: ScenarioKind | 'baseline'; counterexamples?: CounterexampleEntry[] }[];
}

export function seedAll(service: GelService, force = false): SeedReport {
  const projects: SeedReport['projects'] = [];

  // 1) 主叙事：基线 + 参数修订 + 局部源改动 + 冲突决定（全部走服务端事件 API）
  if (force || !service.store.projectExists(BASELINE_PROJECT)) {
    service.loadScenario(BASELINE_PROJECT, 'baseline', force);
    // 自动候选（事件 1）
    const auto = service.compute(BASELINE_PROJECT, { actor: 'auto' });
    const autoResultId = auto.data?.resultId;

    // 参数修订：只改检测参数（ruleVersion 不变，paramsHash 变化 -> 新结果；旧结果保留）
    const tuned = service.compute(BASELINE_PROJECT, {
      actor: 'reviewer',
      params: { peak: { minHeight: 8, saturationLevel: 252, resolutionValley: 0.55, tailAsymmetry: 1.6 } }
    });
    const tunedResultId = tuned.data?.resultId;

    // 互相冲突的人工决定：同一条带，先“接受自动候选”，再“否定并要求人工复核”
    if (autoResultId) {
      service.recordDecision(BASELINE_PROJECT, 'br-main', {
        targetType: 'band',
        targetIdentity: 'lane-s1-b3',
        status: 'accepted',
        fromResultId: autoResultId,
        note: '采纳自动候选分子量（决定 A）',
        paramDiff: {}
      });
    }
    if (tunedResultId) {
      service.recordDecision(BASELINE_PROJECT, 'br-main', {
        targetType: 'band',
        targetIdentity: 'lane-s1-b3',
        status: 'rejected',
        fromResultId: tunedResultId,
        note: '冲突决定：参数修订后否定该分子量，转人工复核（决定 B，A 仍保留）',
        paramDiff: { minHeight: 8, saturationLevel: 252 }
      });
    }

    // 只影响局部依赖的源数据改动：移动一条样本带（其它泳道结论不受影响）
    const stateBefore = service.viewState(BASELINE_PROJECT, 'br-main');
    const band = [...stateBefore.bands.values()].find((b) => b.identity === 'lane-s2-b3');
    if (band) {
      service.reviseBand(BASELINE_PROJECT, 'br-main', {
        ...band,
        center: { x: band.center.x, y: Math.min(400, band.center.y + 60), frame: band.center.frame },
        window: { ...band.window, y0: band.window.y0 + 60, y1: Math.min(420, band.window.y1 + 60) }
      });
    }
    const afterMove = service.compute(BASELINE_PROJECT, { actor: 'reviewer' });
    if (afterMove.data?.resultId && tunedResultId) {
      // 标记局部失效依据（机器可读事件已在结果里；这里留下决定层指针）
      service.recordDecision(BASELINE_PROJECT, 'br-main', {
        targetType: 'band',
        targetIdentity: 'lane-s2-b3',
        status: 'param-adjusted',
        fromResultId: afterMove.data.resultId,
        note: '只移动 lane-s2-b3 的像素中心：仅该带及其插值段失效，其它泳道依赖未变',
        paramDiff: { centerDeltaY: 60 }
      });
    }

    // 2) 冲突决定专门项目：同一饱和带，采纳候选 vs 否定
    projects.push({ id: BASELINE_PROJECT, name: service.store.getProject(BASELINE_PROJECT)!.name, kind: 'baseline' });
  }

  // 3) 反例档案：每个情形独立项目 + 一个反例分支（分支上替换为只改一个来源的情形）
  const catalog: CounterexampleEntry[] = [];
  for (const ce of COUNTEREXAMPLE_KINDS) {
    if (force || !service.store.projectExists(ce.projectId)) {
      service.loadScenario(ce.projectId, 'baseline', force);
      const base = service.compute(ce.projectId, { actor: 'auto' });
      const baseResultId = base.data?.resultId ?? null;

      // fork 反例分支并在其上装载“只改一个直接来源”的情形材料
      service.createBranch(ce.projectId, {
        id: 'br-counterexample',
        name: ce.branchName,
        purpose: 'counterexample',
        changedDirectSource: ce.changedSource
      });
      const forked = applyCounterVariant(service, ce.projectId, ce.kind);

      const entry: CounterexampleEntry = {
        branchId: 'br-counterexample',
        changedDirectSource: ce.changedSource,
        adoptedResultId: forked?.resultId ?? null,
        rejectedResultIds: baseResultId ? [baseResultId] : [],
        machineEventCodes: forked?.machineEventCodes ?? [],
        affectedObjects: forked?.affectedObjects ?? [],
        expectedScope: forked?.expectedScope ?? ce.changedSource,
        observedScope: forked?.observedScope ?? ''
      };
      service.setCounterexamples(ce.projectId, [entry]);
      catalog.push({ ...entry, branchId: ce.projectId });
      projects.push({
        id: ce.projectId,
        name: buildScenario(ce.kind).spec.title,
        kind: ce.kind,
        counterexamples: [entry]
      });
    } else {
      const row = service.getCounterexamples(ce.projectId);
      projects.push({
        id: ce.projectId,
        name: service.store.getProject(ce.projectId)!.name,
        kind: ce.kind,
        counterexamples: row
      });
    }
  }

  return { projects };
}

function applyCounterVariant(
  service: GelService,
  projectId: string,
  kind: ScenarioKind
): { resultId: string | null; machineEventCodes: string[]; affectedObjects: string[]; expectedScope: string; observedScope: string } {
  // 反例分支：装载变体蓝图的几何/条带修订到该分支（图像与材料作为分支上的新事件）
  const variant = installVariantOnBranch(service, projectId, 'br-counterexample', kind);
  const run = service.compute(projectId, { branchId: 'br-counterexample', actor: 'auto' });
  const resultId = run.data?.resultId ?? null;
  const result = resultId ? service.getResult(projectId, resultId) : undefined;
  const codes = result?.machineEvents.map((e) => e.code) ?? [];
  const observed =
    kind === 'revision-local-invalidation'
      ? scopeForLocalInvalidation(service, projectId, resultId)
      : variant.affected.join(',');
  return {
    resultId,
    machineEventCodes: codes,
    affectedObjects: variant.affected,
    expectedScope: variant.expectedScope,
    observedScope: observed
  };
}

function scopeForLocalInvalidation(service: GelService, projectId: string, resultId: string | null): string {
  if (!resultId) return '计算失败，无对象';
  const result = service.getResult(projectId, resultId);
  const invalidBands =
    result?.lanes
      .flatMap((l) => l.bands)
      .filter((b) => b.status !== 'definite')
      .map((b) => b.bandId) ?? [];
  return `受影响：${invalidBands.join(',') || '无'}（应仅 lane-s2-b3 一带）`;
}

import { installVariantOnBranch } from './branch-variant.js';
