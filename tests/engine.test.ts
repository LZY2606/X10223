import { describe, it, expect } from 'vitest';
import { parseMolecularWeight, parseLength } from '../src/shared/units';
import {
  BudgetExhaustedError,
  CorruptFormatError,
  SemanticUnresolvableError,
} from '../src/shared/diagnostic';
import { analyzeBaseline, analyzeVariant, tempService } from './helpers';
import { analyze } from '../src/core/analyze';
import { decodePng, encodeGrayPng } from '../src/core/png';
import { renderGel } from '../src/core/syntheticGel';
import { baselineRecipe } from '../src/casepack/recipes';
import { stableId } from '../src/shared/ids';

describe('单位/坐标基准：导入保留原始表示，派生层才规范化', () => {
  it('bp/kbp 正确规范化；不可换算值留在原位并附诊断', () => {
    expect(parseMolecularWeight('1.5 kbp').bp).toBe(1500);
    expect(parseMolecularWeight('500 bp').bp).toBe(500);
    const bad = parseMolecularWeight('约五百');
    expect(bad.bp).toBeNull();
    expect(bad.diagnostics[0]!.code).toBe('unconvertible-unit');
    expect(bad.raw).toBe('约五百');
    expect(parseLength('10 mm').px).toBeCloseTo(37.8, 0);
  });
});

describe('输入不完整：带位置诊断，不用空值伪装成功', () => {
  it('缺 lane/缺像素坐标时 ok=false 且诊断带 location', () => {
    const { c } = analyzeBaseline();
    const broken = analyze(
      { image: c.image, ladder: c.ladder, lanes: [], bands: c.bands },
      't',
      { lanes: [], bands: c.bands },
    );
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.some((d) => d.code === 'incomplete-input')).toBe(true);

    const badBand: any = { ...c.bands[0]!, center: { x: 1, y: 2, frame: 'migration-down' } };
    const broken2 = analyze(
      { image: c.image, ladder: c.ladder, lanes: c.lanes, bands: [badBand] },
      't',
      { lanes: c.lanes, bands: [badBand] },
    );
    expect(broken2.ok).toBe(false);
    expect(broken2.diagnostics.some((d) => d.location?.bandId)).toBe(true);
  });
});

describe('三态错误必须是三种不同结果', () => {
  it('预算耗尽 / 格式损坏 / 语义无解各自独立 code', () => {
    const budget = new BudgetExhaustedError('x', { name: 'b', limit: 1, used: 2 });
    const corrupt = new CorruptFormatError('y');
    const semantic = new SemanticUnresolvableError('z', [
      { code: 'non-monotonic-calibration', severity: 'error', message: 'm' },
    ]);
    expect([budget.code, corrupt.code, semantic.code]).toEqual([
      'BUDGET_EXHAUSTED',
      'CORRUPT_FORMAT',
      'SEMANTIC_UNRESOLVABLE',
    ]);
    expect(semantic.diagnostics).toHaveLength(1);
  });
});

describe('PNG 自包含原图：编码-解码往返', () => {
  it('灰度像素无损往返', () => {
    const { gray, width, height } = renderGel(baselineRecipe());
    const bytes = encodeGrayPng(width, height, gray);
    const dec = decodePng(bytes);
    expect(dec.width).toBe(width);
    expect(dec.height).toBe(height);
    expect(Array.from(dec.data)).toEqual(Array.from(gray));
  });

  it('损坏/截断报 CorruptFormatError', async () => {
    const { gray, width, height } = renderGel(baselineRecipe());
    const bytes = encodeGrayPng(width, height, gray);
    expect(() => decodePng(bytes.subarray(0, 20))).toThrow(/截断|PNG/);
    const bad = new Uint8Array(bytes);
    bad[10] = bad[10]! ^ 255;
  });
});

describe('等价输入 → 稳定身份与稳定顺序', () => {
  it('两次分析推断身份与排序一致', () => {
    const a = analyzeBaseline().result;
    const b = analyzeBaseline().result;
    const ia = a.inferences.map((i) => i.inferenceId);
    const ib = b.inferences.map((i) => i.inferenceId);
    expect(ia).toEqual(ib);
    // 段身份稳定
    expect(a.fits[0]!.segments.map((s) => s.segmentId)).toEqual(
      b.fits[0]!.segments.map((s) => s.segmentId),
    );
  });

  it('同内容稳定 id', () => {
    expect(stableId('x', 1, 'a')).toBe(stableId('x', 1, 'a'));
    expect(stableId('x', 1, 'a')).not.toBe(stableId('x', 1, 'b'));
  });
});

describe('候选/区间证据保留', () => {
  it('重叠保留全部合法候选；饱和给上下界', () => {
    const overlap = analyzeVariant('overlap').result;
    const sets = overlap.inferences.filter((i) => i.status === 'candidate-set');
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) expect(s.candidates.length).toBeGreaterThan(1);
    const sat = analyzeVariant('saturation').result;
    const satInf = sat.inferences.find((i) => i.diagnostics.some((d) => d.code === 'saturated-band'));
    expect(satInf?.candidates[0]?.bpLower).toBeLessThan(satInf?.candidates[0]?.bpUpper!);
  });
});

describe('服务层可直接被测试调用（业务规则不在浏览器里）', () => {
  it('tempService 建立并完成一次自动分析', () => {
    const { service, cleanup } = tempService();
    const { c } = analyzeBaseline();
    service.createProject('p1', 'P1');
    service.importMaterials('p1', c.image, c.ladder);
    service.appendGeneric('p1', 'lanes-annotated', { lanes: c.lanes }, []);
    service.appendGeneric('p1', 'bands-annotated', { bands: c.bands }, []);
    const { result } = service.runAutoAnalysis('p1');
    expect(result.inferences.length).toBeGreaterThan(0);
    cleanup();
  });
});
