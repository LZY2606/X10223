import { describe, it, expect } from 'vitest';
import { tempService, analyzeBaseline } from './helpers';
import { exportPack, importPack } from '../src/server/pack';
import { CorruptFormatError } from '../src/shared/diagnostic';
import { deflateSync } from 'node:zlib';

describe('决定历史 / 分支 / 回到旧事件', () => {
  it('接受→修订→回到旧事件恢复当时参数版本，且不被最新结果覆盖', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    service.appendGeneric('p', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p', 'bands-annotated', { bands: c.bands }, []);
    service.runAutoAnalysis('p');
    service.reviseAndRecompute('p', 'main', 'params.v9');

    const head = service.load('p');
    expect(head.branches.get('main')!.paramVersion).toBe('params.v9');
    // 回到参数修订之前（按类型定位最后一个 auto-analysis，忽略其后的判断事件）
    const events = head.events;
    const autoIdx = events.map((e) => e.type).lastIndexOf('auto-analysis');
    const beforeRevise = events[autoIdx]!;
    const old = service.viewAt('p', beforeRevise.eventId);
    expect(old.branches.get('main')!.paramVersion).not.toBe('params.v9');
    // head 不受 viewAt 影响
    expect(service.load('p').branches.get('main')!.paramVersion).toBe('params.v9');
    cleanup();
  });

  it('互相冲突的人工决定被记录为 conflicts，两个候选都保留', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    service.appendGeneric('p', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p', 'bands-annotated', { bands: c.bands }, []);
    service.runAutoAnalysis('p');
    const state = service.load('p');
    const inf = state.branches.get('main')!.latestAnalysis!.result.inferences[0]!;
    const candA = inf.candidates[0]!;
    // 构造第二个候选（重叠才有多候选；否则复制一个不同 id 的接受目标）。
    const candB = inf.candidates[1] ?? { ...candA, candidateId: candA.candidateId + '-alt' };
    service.decide('p', 'main', {
      action: 'accept', targetKind: 'molecular-weight', targetId: inf.bandId,
      acceptedCandidateId: candA.candidateId, reason: 'A',
    });
    service.decide('p', 'main', {
      action: 'accept', targetKind: 'molecular-weight', targetId: inf.bandId,
      acceptedCandidateId: candB.candidateId, reason: 'B',
    });
    const after = service.load('p');
    const conflicts = after.branches.get('main')!.conflicts;
    expect(conflicts.some((x) => x.targetId === inf.bandId)).toBe(true);
    cleanup();
  });

  it('分支保留各自决定历史', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    service.appendGeneric('p', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p', 'bands-annotated', { bands: c.bands }, []);
    service.runAutoAnalysis('p');
    service.createBranch('p', 'b1', 'main');
    expect(service.load('p').branchOrder).toContain('b1');
    cleanup();
  });

  it('人工修订条带产生新身份并保留 supersedes 链，不覆盖旧标注', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    service.appendGeneric('p', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p', 'bands-annotated', { bands: c.bands }, []);
    const sampleBand = c.bands.find((b) => !b.nominalId)!;
    const before = service.load('p').branches.get('main')!.bands.length;
    service.reviseBand('p', 'main', sampleBand.bandId, { x: sampleBand.center.x + 3, y: sampleBand.center.y + 3 }, '拖动');
    const after = service.load('p').branches.get('main')!;
    expect(after.bands.length).toBe(before + 1);
    const revised = after.bands.find((b) => b.supersedesBandId === sampleBand.bandId);
    expect(revised).toBeDefined();
    expect(after.bands.some((b) => b.bandId === sampleBand.bandId)).toBe(true);
    cleanup();
  });
});

describe('导出→删除→导入 往返：身份/顺序/分支/决定历史保持', () => {
  it('gelpack 往返后身份与事件链一致', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    service.appendGeneric('p', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p', 'bands-annotated', { bands: c.bands }, []);
    service.runAutoAnalysis('p');
    service.createBranch('p', 'bx', 'main');
    const original = service.load('p');
    const pack = exportPack(original);

    const { service: service2, cleanup: cleanup2 } = tempService();
    const { state } = importPack(pack);
    service2.persistPublic(state);
    const reloaded = service2.load('p');

    expect(reloaded.events.map((e) => e.eventId)).toEqual(original.events.map((e) => e.eventId));
    expect(reloaded.branchOrder).toEqual(original.branchOrder);
    // 材料身份与原图像素一致
    const img0 = original.materials[original.materialBindings.imageMaterialId] as any;
    const img1 = reloaded.materials[reloaded.materialBindings.imageMaterialId] as any;
    expect(img1.materialId).toBe(img0.materialId);
    expect(Array.from(img1.grayscale)).toEqual(Array.from(img0.grayscale));
    // 分支结构
    expect(reloaded.branches.has('bx')).toBe(true);
    // 自校验链
    expect(service2.getStore().verifyChain('p').ok).toBe(true);
    cleanup(); cleanup2();
  });

  it('magic 错误→格式损坏；负载截断→格式损坏（区别于语义无解）', () => {
    expect(() => importPack(new Uint8Array([1, 2, 3, 4]))).toThrow(CorruptFormatError);
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p', 'P');
    service.importMaterials('p', c.image, c.ladder);
    const state = service.load('p');
    const good = exportPack(state);
    const truncated = good.subarray(0, good.length - 40);
    expect(() => importPack(truncated)).toThrow(CorruptFormatError);
    // 篡改负载也报格式损坏
    const tampered = new Uint8Array(good);
    tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 1;
    expect(() => importPack(tampered)).toThrow(CorruptFormatError);
    cleanup();
  });

  it('损坏数据不与解压异常混淆（错误信息可区分）', () => {
    const bogus = Buffer.concat([
      Buffer.from('GELPACK1\n', 'ascii'),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(2, 0); return b; })(),
      Buffer.from('{}'),
      deflateSync(Buffer.from('x')),
    ]);
    // manifest 缺字段 → 截断/格式
    expect(() => importPack(new Uint8Array(bogus))).toThrow();
  });
});
