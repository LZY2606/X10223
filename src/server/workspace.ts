import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { buildBranchSeeds } from './branches.js';
import type { CasePack } from '../../scripts/casepack-schema.js';
import { sha256Hex } from '../shared/digest.js';
import { BASELINE_PARAMS, REVISED_PARAMS, type Event, type Material, type Project } from '../shared/types.js';

const PROJECT_ID = 'prj-gel-demo';

export function casePackPath(...parts: string[]) {
  return join(process.cwd(), 'casepack', ...parts);
}

export function loadCasePack(): { pack: CasePack; images: Record<string, Buffer> } {
  const pack = JSON.parse(readFileSync(casePackPath('manifest.json'), 'utf8')) as CasePack;
  const images: Record<string, Buffer> = { 'baseline.png': readFileSync(casePackPath('baseline.png')) };
  for (const sc of pack.scenarios) {
    const f = `scenarios/${sc.id}.png`;
    images[f] = readFileSync(casePackPath(f));
  }
  return { pack, images };
}

export function seedStore(store: Store, opts: { force?: boolean } = {}): Project {
  const existing = store.getProject(PROJECT_ID);
  if (existing && !opts.force) return existing;
  if (existing) store.deleteProject(PROJECT_ID);

  const { pack, images } = loadCasePack();
  const project: Project = {
    id: PROJECT_ID,
    name: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
    casePackVersion: pack.version,
    createdAt: pack.createdAt,
  };
  store.putProject(project);

  const baseSha = sha256Hex(images['baseline.png']);
  store.putBlob(baseSha, images['baseline.png']);

  // 不可变材料
  for (const m of pack.baseline.materials) store.putMaterial(PROJECT_ID, m);
  for (const [file, buf] of Object.entries(images)) {
    if (file === 'baseline.png') continue;
    store.putBlob(sha256Hex(buf), buf);
  }

  const imageByFile: Record<string, { sha: string }> = {};
  for (const [file, buf] of Object.entries(images)) imageByFile[file] = { sha: sha256Hex(buf) };

  store.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('project-created',?)")
    .run(JSON.stringify({ name: project.name, casePackVersion: pack.version, at: pack.createdAt }));

  const seeds = buildBranchSeeds({ imageBaseSha: baseSha, imageByFile, materials: pack.baseline.materials });
  for (const seed of seeds) {
    store.db.prepare(`INSERT INTO branches(id,project_id,name,head_event_id,forked_from_event_id,purpose,seq_counter)
      VALUES(?,?,?,?,?,?,?)`).run(
      seed.branchId, PROJECT_ID, seed.name, null, null, seed.purpose, -1,
    );
    const mats = pack.baseline.materials.map((m) => m.id);
    store.appendEvent(PROJECT_ID, seed.branchId, 'materials-imported', { materialIds: mats, importFileName: 'casepack.zip' }, 'importer');
    for (const ev of seed.events) {
      store.appendEvent(PROJECT_ID, seed.branchId, ev.type as never, ev.payload as never);
    }
  }

  // 主分支：参数修订（一次）
  store.appendEvent(PROJECT_ID, 'br-main', 'param-revision', {
    fromVersion: BASELINE_PARAMS.version, toVersion: REVISED_PARAMS.version,
    reason: '审阅：饱和阈值收紧（演示参数修订历史）',
  });
  // 主分支：一次只影响局部依赖的源数据改动（人工挪动 lane-2 一个 band 中心）
  store.appendEvent(PROJECT_ID, 'br-main', 'source-patch', {
    target: 'band:center', materialId: 'bands-baseline', fieldPath: 'bands[lane-2-b124].center',
    summary: '人工把 lane-2 s≈124 的条带中心横向微调 2px（只影响该 band 节点）',
    scope: { bandIds: ['lane-2-b124'] },
    newBandCenter: { bandId: 'lane-2-b124', center: { x: 110, y: 24 + 124 } },
  });

  // 冲突人工决定：在主分支接受 lane-1-b160=某 bp；再开一个决定分支否定同一 band（引用冲突，不覆盖）
  store.appendEvent(PROJECT_ID, 'br-main', 'band-decision', {
    bandId: 'lane-1-b160', laneId: 'lane-1',
    decision: { kind: 'accept', bp: 489 },
    reason: '主分支：采纳自动候选（示例值）',
  });
  const mainHead = store.getBranch('br-main')!.headEventId!;
  const mainDecision = store.listEvents('br-main').find((e) => e.type === 'band-decision')!;
  store.forkBranch(PROJECT_ID, 'br-conflict', '冲突决定分支',
    '同一 band 的互相冲突人工决定（保留双方，不覆盖历史）', 'br-main', mainHead);
  store.appendEvent(PROJECT_ID, 'br-conflict', 'band-decision', {
    bandId: 'lane-1-b160', laneId: 'lane-1',
    decision: { kind: 'reject', reason: '489bp 落在可疑区，改判不可接受' },
    conflictsWith: mainDecision.id,
    reason: '冲突分支：否定主分支决定（并存，不覆盖）',
  });

  return project;
}

export function replayEvents(store: Store, branchId: string, uptoSeq?: number): {
  events: Event[]; project: Project; materials: Material[];
} {
  const project = store.getProject(PROJECT_ID)!;
  const all = store.listEvents(branchId);
  const events = uptoSeq === undefined ? all : all.filter((e) => e.seq <= uptoSeq);
  const materialIds = new Set<string>();
  for (const e of events) if (e.type === 'materials-imported') e.payload.materialIds.forEach((id) => materialIds.add(id));
  const baseMaterials = store.listMaterials(PROJECT_ID).filter((m) => materialIds.has(m.id));
  return { events, project, materials: baseMaterials };
}

export { PROJECT_ID };
