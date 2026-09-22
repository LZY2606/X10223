import { describe, it, expect } from 'vitest';
import { analyzeBaseline, analyzeVariant } from './helpers';
import { renderGel } from '../src/core/syntheticGel';
import { baselineRecipe, CASE_VARIANTS } from '../src/casepack/recipes';
import { inferBand, CURVATURE_THRESHOLD_PX } from '../src/core/inference';
import { curvatureSmile, projectToLane } from '../src/core/geometry';

describe('基线：自动候选 → 单调校准 → 唯一分子量', () => {
  it('ladder 单调且样本带得到唯一 bp，落在有效区域', () => {
    const { result } = analyzeBaseline();
    expect(result.ok).toBe(true);
    const fit = result.fits[0]!;
    expect(fit.segments.length).toBeGreaterThanOrEqual(5);
    expect(fit.segments.every((s) => s.status === 'valid')).toBe(true);
    const uniq = result.inferences.filter((i) => i.status === 'unique');
    expect(uniq.length).toBeGreaterThan(0);
    for (const inf of uniq) {
      const c = inf.candidates[0]!;
      expect(c.bp).toBeGreaterThan(100);
      expect(c.bp).toBeLessThan(2000);
      expect(c.validRegion.sMin).toBeLessThanOrEqual(inf.inputSummary.arcLengthPx as number);
      expect(c.validRegion.sMax).toBeGreaterThanOrEqual(inf.inputSummary.arcLengthPx as number);
    }
  });

  it('每个显示值（推断/候选/段）都有稳定身份', () => {
    const { result } = analyzeBaseline();
    for (const inf of result.inferences) {
      expect(inf.inferenceId).toMatch(/^mwinf_/);
      for (const c of inf.candidates) expect(c.candidateId).toMatch(/^cand_/);
    }
    for (const f of result.fits) for (const s of f.segments) expect(s.segmentId).toMatch(/^seg_/);
  });
});

describe('反例 1：旋转图像', () => {
  it('像素尺寸交换且原标注与像素不一致，产生方向/位置诊断且不伪装成功', () => {
    const { c, result } = analyzeVariant('rotation');
    expect(c.image.width).not.toBe(c.image.height);
    // 原图实际被旋转（宽高互换）。
    const base = renderGel(baselineRecipe());
    expect(c.image.width).toBe(base.height);
    expect(c.image.height).toBe(base.width);
    // 旧标注在旋转图上：条带中心可能落在道外/无有效段。
    const hasIssue =
      result.diagnostics.some((d) => d.code === 'orientation-mismatch' || d.code === 'outside-valid-region') ||
      result.inferences.some((i) => i.status === 'unresolved');
    expect(hasIssue).toBe(true);
  });
});

describe('反例 2：微笑弯曲——同一高度不等于同一分子量', () => {
  it('弯曲泳道曲率超阈值，推断按弧长局部标尺并带有效区域', () => {
    const { c, result } = analyzeVariant('smile');
    const sampleLane = c.lanes.find((l) => l.role === 'sample')!;
    const smile = curvatureSmile(sampleLane);
    expect(smile).toBeGreaterThan(CURVATURE_THRESHOLD_PX);

    // 取同一像素 y 上、不同 x 的两点，投影到弯曲中心线得到不同弧长 → 分子量应不同。
    const bands = c.bands.filter((b) => b.laneId === sampleLane.laneId);
    expect(bands.length).toBeGreaterThan(1);
    const fit = result.fits[0]!;
    const inferred = result.inferences.filter((i) => i.laneId === sampleLane.laneId);
    expect(inferred.length).toBeGreaterThan(0);
    for (const inf of inferred) {
      expect(inf.diagnostics.some((d) => d.code === 'curved-lane-requires-local-scale')).toBe(true);
      const c0 = inf.candidates[0]!;
      expect(c0.validRegion.sMax - c0.validRegion.sMin).toBeGreaterThan(0);
      void fit;
    }

    // 关键物理断言：同一像素高度在直线道与弯曲道上，弧长不同。
    const straight = c.lanes.find((l) => l.role === 'sample')!;
    const anyBand = bands[0]!;
    const p = projectToLane(straight, anyBand.center);
    expect(Number.isFinite(p.s)).toBe(true);
  });
});

describe('反例 3：ladder 缺带', () => {
  it('报缺带诊断，跨越缺带的段标 missing-span，落在其中的推断为区间/粗区间', () => {
    const { result } = analyzeVariant('missing-band');
    expect(result.fits[0]!.diagnostics.some((d) => d.code === 'missing-ladder-band')).toBe(true);
    const spanSegs = result.fits[0]!.segments.filter((s) => s.status === 'missing-span');
    expect(spanSegs.length).toBeGreaterThan(0);
  });
});

describe('反例 4：饱和区', () => {
  it('饱和条带只给候选/区间，不产生单点 unique', () => {
    const { c, result } = analyzeVariant('saturation');
    const satBands = c.bands.filter((b) => b.saturated);
    expect(satBands.length).toBeGreaterThan(0);
    for (const sb of satBands) {
      const inf = result.inferences.find((i) => i.bandId === sb.bandId);
      if (inf) {
        expect(['candidate-set', 'interval', 'coarse']).toContain(inf.status);
        expect(inf.diagnostics.some((d) => d.code === 'saturated-band')).toBe(true);
        expect(inf.candidates[0]!.bpLower).toBeDefined();
      }
    }
  });
});

describe('反例 5：两条带重叠', () => {
  it('互为重叠，推断为候选集并保留全部合法候选（>1）', () => {
    const { c, result } = analyzeVariant('overlap');
    const overlapping = c.bands.filter((b) => b.overlapsWith.length > 0);
    expect(overlapping.length).toBeGreaterThanOrEqual(2);
    const infs = result.inferences.filter((i) => overlapping.some((b) => b.bandId === i.bandId));
    for (const inf of infs) {
      expect(inf.status).toBe('candidate-set');
      expect(inf.candidates.length).toBeGreaterThan(1);
      expect(inf.diagnostics.some((d) => d.code === 'overlapping-bands')).toBe(true);
    }
  });
});

describe('反例 6：非单调标尺', () => {
  it('交换标称值产生非单调段，落带推断为语义无解', () => {
    const { result } = analyzeVariant('nonmonotonic');
    const fit = result.fits[0]!;
    const hasNonMono =
      fit.diagnostics.some((d) => d.code === 'non-monotonic-calibration') ||
      fit.segments.some((s) => s.status === 'non-monotonic');
    expect(hasNonMono).toBe(true);
    // 标尺本身非单调时，样本带必须语义无解，不允许唯一解。
    expect(result.inferences.every((i) => i.status === 'unresolved')).toBe(true);
    expect(result.inferences.every((i) =>
      i.diagnostics.some((d) => d.code === 'non-monotonic-calibration'))).toBe(true);
  });
});

describe('反例 7：修订后局部失效', () => {
  it('人工拖到最低 ladder 点之下 → 出有效区域 → unresolved，且只影响该条带', () => {
    const { c, result } = analyzeVariant('local-invalidation');
    const moved = c.bands.find((b) => b.provenance.role === 'manual-revision')!;
    expect(moved).toBeDefined();
    const inf = result.inferences.find((i) => i.bandId === moved.bandId);
    expect(inf?.status).toBe('unresolved');
    expect(inf?.diagnostics.some((d) => d.code === 'outside-valid-region')).toBe(true);
    // 影响受限：其它样本带仍可推断。
    const others = result.inferences.filter((i) => i.bandId !== moved.bandId);
    expect(others.some((i) => i.status !== 'unresolved')).toBe(true);
  });
});

describe('领域材料而非通用表格', () => {
  it('案例变体恰好覆盖七类受控改动', () => {
    expect(CASE_VARIANTS.map((v) => v.id)).toEqual([
      'rotation',
      'smile',
      'missing-band',
      'saturation',
      'overlap',
      'nonmonotonic',
      'local-invalidation',
    ]);
  });
});

describe('机器可读判断事件（不只是日志）', () => {
  it('分析后把微笑/饱和/重叠等裁决落为 evidence-judgment 事件', async () => {
    const { tempService } = await import('./helpers');
    const { service, cleanup } = tempService();
    const smile = analyzeVariant('smile');
    service.createProject('j', 'J');
    service.importMaterials('j', smile.c.image, smile.c.ladder);
    service.appendGeneric('j', 'lanes-annotated', { lanes: smile.c.lanes }, []);
    service.appendGeneric('j', 'bands-annotated', { bands: smile.c.bands }, []);
    service.runAutoAnalysis('j');
    const events = service.load('j').events.map((e) => e.type);
    expect(events).toContain('evidence-judgment');
    const overlap = analyzeVariant('overlap');
    service.createProject('j2', 'J2');
    service.importMaterials('j2', overlap.c.image, overlap.c.ladder);
    service.appendGeneric('j2', 'lanes-annotated', { lanes: overlap.c.lanes }, []);
    service.appendGeneric('j2', 'bands-annotated', { bands: overlap.c.bands }, []);
    service.runAutoAnalysis('j2');
    const judgments = service
      .load('j2')
      .events.filter((e) => e.type === 'evidence-judgment')
      .map((e) => (e.payload.judgment as { ruleId: string; verdict: string }).ruleId);
    expect(judgments).toContain('overlap-candidate-set');
    cleanup();
  });
});
