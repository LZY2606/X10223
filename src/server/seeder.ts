import { ProjectService } from './projectService';
import { buildBaseline, buildVariant } from '../casepack/builder';

export const SAMPLE_PROJECT_ID = 'sample-gel-case';
export const VARIANT_IDS = ['rotation', 'smile', 'missing-band', 'saturation', 'overlap', 'nonmonotonic', 'local-invalidation'] as const;

/**
 * 初始版本完整叙事：
 *  建项目 → 导入材料 → 像素级 lanes/bands → 自动分析（自动候选）
 *  → 参数修订 → 只影响局部依赖的源改动（弯曲泳道）→ 冲突人工决定（另开分支）。
 */
export function seedSampleProject(service: ProjectService): { projectId: string } {
  const store = service.getStore();
  if (store.listProjects().some((p) => p.projectId === SAMPLE_PROJECT_ID)) {
    return { projectId: SAMPLE_PROJECT_ID };
  }

  const c = buildBaseline();
  service.createProject(SAMPLE_PROJECT_ID, '胶道标尺案例：自动候选 vs 人工修订');
  service.importMaterials(SAMPLE_PROJECT_ID, c.image, c.ladder);
  service.appendGeneric(SAMPLE_PROJECT_ID, 'lanes-annotated', { lanes: c.lanes }, [c.image.materialId]);

  service.runAutoAnalysis(SAMPLE_PROJECT_ID);
  service.reviseAndRecompute(SAMPLE_PROJECT_ID, 'main', 'params.v2-curvature-aware');

  // 只影响局部依赖的源数据改动：把 L1 修订为“微笑”弯曲，再重算。
  const smile = buildVariant('smile');
  const smileLane = smile.lanes.find((l) => l.label === 'L1')!;
  let state = service.load(SAMPLE_PROJECT_ID);
  const mainLane = state.branches.get('main')!.lanes.find((l) => l.label === 'L1')!;
  service.reviseLaneCurve(
    SAMPLE_PROJECT_ID,
    'main',
    mainLane.laneId,
    smileLane.centerline.points.map((p) => ({ x: p.x, y: p.y })),
    '局部源改动：把 L1 修订为“微笑”弯曲（仅影响依赖该道的推断）',
  );
  service.reviseAndRecompute(SAMPLE_PROJECT_ID, 'main', 'params.v2-curvature-aware');

  // 互相冲突的人工决定：main 与 review-alt 接受不同候选。
  state = service.load(SAMPLE_PROJECT_ID);
  const branch = state.branches.get('main')!;
  const inf = branch.latestAnalysis?.result.inferences.find((i) => i.candidates.length > 0);
  if (inf) {
    service.decide(SAMPLE_PROJECT_ID, 'main', {
      action: 'accept',
      targetKind: 'molecular-weight',
      targetId: inf.bandId,
      acceptedCandidateId: inf.candidates[0]!.candidateId,
      reason: 'main：采用首选分子量候选',
    });
    service.createBranch(SAMPLE_PROJECT_ID, 'review-alt', 'main');
    // 即使首选唯一，复核者在分支上做参数调整，改采替代候选（与 main 冲突，二者都保留）。
    const chosen = inf.candidates[0]!;
    const altCandidateId = inf.candidates[1]?.candidateId ?? `${chosen.candidateId}-alt-revised`;
    service.decide(SAMPLE_PROJECT_ID, 'review-alt', {
      action: 'adjust',
      targetKind: 'molecular-weight',
      targetId: inf.bandId,
      acceptedCandidateId: altCandidateId,
      adjustment: { bpPercentShift: -8, rationale: '复核者认为曲率校正过强，下调 8%' },
      reason: 'review-alt：曲率校正调整后改采替代候选（与 main 冲突，双方均保留）',
    });
  }

  for (const variantId of VARIANT_IDS) seedVariant(service, variantId);
  return { projectId: SAMPLE_PROJECT_ID };
}

function seedVariant(service: ProjectService, variantId: string) {
  const v = buildVariant(variantId);
  const pid = `case-${variantId}`;
  service.createProject(pid, `反例 · ${v.title}`);
  service.importMaterials(pid, v.image, v.ladder);
  service.appendGeneric(pid, 'lanes-annotated', { lanes: v.lanes }, [v.image.materialId]);
  service.appendGeneric(pid, 'bands-annotated', { bands: v.bands }, [v.image.materialId]);
  service.appendGeneric(pid, 'source-mutated', { changedSource: v.changedSource, variantId }, [v.image.materialId]);
  // 走正式分析管线：产生快照 + 机器可读 evidence-judgment 事件。
  service.runAutoAnalysis(pid);
}
