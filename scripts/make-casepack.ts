import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPng, rotatePng, savePng, baselineMaterials, OUT } from './build-casepack.ts';
import { GEL_W, GEL_H } from './bp-layout.js';
import type { CasePack, ScenarioSpec } from './casepack-schema.js';

const scenarios: ScenarioSpec[] = [
  {
    id: 'rotated-image',
    title: '旋转图像（只改图像方向这一个直接来源）',
    changesOneSource: 'source-image: 将原图旋转 90°；材料像素值不变，拍摄方向确认事件变为 rotationApplied=90',
    expects: {
      statuses: {},
      diagnosticCodes: [],
      narrative: '旋转后重投影的条带弧长与基线一致；身份不变，仅 rotated-image 节点摘要改变。',
    },
    render: { rotate: 90 },
  },
  {
    id: 'curved-lanes',
    title: '弯曲泳道（微笑）：同一高度 ≠ 同一分子量',
    changesOneSource: 'lanes:curves —— 仅把中心线由直线改为微笑曲线，图像像素随之按曲线重绘，ladder 标称不变',
    expects: {
      diagnosticCodes: [],
      statuses: {},
      narrative: '直线道按 y 对齐会把弯曲道的条带配错；沿曲线取弧长后局部标尺恢复，并带有效区域。',
    },
    render: { smile: true },
    patch: { kind: 'curves', detail: { amplitudePx: 10 } },
  },
  {
    id: 'ladder-missing-band',
    title: 'ladder 缺带',
    changesOneSource: 'image:pixels —— 仅抹除 500bp 这一条 ladder 带（图像与该 band 来源），标称条目保留',
    expects: {
      diagnosticCodes: ['LADDER_MISSING_BAND'],
      statuses: {},
      narrative: '500bp 槽位缺失，300..750 之间合并为跨段插值，标称 500bp 仍留在列表并标 missing。',
    },
    render: { missingLadderAt: [500] },
  },
  {
    id: 'saturated-band',
    title: '饱和区',
    changesOneSource: 'image:pixels —— 仅把 lane-5 的一条带中心打成 255 饱和',
    expects: {
      diagnosticCodes: ['SATURATED_CANDIDATE'],
      statuses: { 'lane-5': ['candidate'] },
      narrative: '饱和条带中心不唯一，只能标候选并给分子量区间，不给单一 bp。',
    },
  },
  {
    id: 'overlap-two-bands',
    title: '两条带重叠',
    changesOneSource: 'image:pixels —— 仅令 lane-3 两条带间距 6px（基线已布置），来源只改像素',
    expects: {
      diagnosticCodes: ['OVERLAP_CANDIDATES'],
      statuses: { 'lane-3': ['candidate'] },
      narrative: '重叠无法唯一决定，保留 overlap-a / overlap-b 全部合法候选与区间。',
    },
  },
  {
    id: 'nonmonotonic-scale',
    title: '非单调标尺',
    changesOneSource: 'ladder:nominal —— 仅交换 750/500 两条标称顺序，像素与条带不动',
    expects: {
      diagnosticCodes: ['SEMANTIC_NO_SOLUTION'],
      statuses: {},
      narrative: 's 增大时 bp 不再单调下降：语义无解，不生成插值段；区别于格式损坏和预算耗尽。',
    },
    patch: { kind: 'nonmonotonic-ladder', detail: { swapOrdinals: [3, 4] } },
  },
  {
    id: 'local-invalidation',
    title: '参数修订后局部失效',
    changesOneSource: 'params —— 唯一变更是参数版本 params-001→params-002（饱和阈值 254→200）',
    expects: {
      diagnosticCodes: ['LOCAL_DEPENDENCY_INVALID', 'SATURATED_CANDIDATE'],
      statuses: {},
      narrative: '只有 lane-5 中本未饱和的条带在新阈值下变候选；其他道节点 id 与结论保持不变。',
    },
    patch: { kind: 'param-revision', detail: { toVersion: 'params-002-saturation-200' } },
  },
];

function main() {
  const baselinePng = buildPng();
  const baseInfo = savePng(baselinePng, 'baseline.png');
  const materials = baselineMaterials(baseInfo.sha);

  for (const sc of scenarios) {
    let png = buildPng({
      smile: sc.render?.smile,
      missingLadderAt: sc.render?.missingLadderAt,
      saturateBand: sc.id === 'saturated-band' ? 'lane-5-b130' : undefined,
    });
    if (sc.render?.rotate) png = rotatePng(png, sc.render.rotate);
    savePng(png, join('scenarios', `${sc.id}.png`));
  }

  const pack: CasePack = {
    version: 'casepack-2026-09-23-v1',
    createdAt: '2026-09-23T03:40:00+09:00',
    baseline: {
      imageFile: 'baseline.png',
      imageWidth: sc_dim(scenarios).w,
      imageHeight: sc_dim(scenarios).h,
      materials,
    },
    scenarios,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(pack, null, 2));
  console.log(`casepack written: baseline.png (${baseInfo.bytes}B sha ${baseInfo.sha.slice(0, 12)}) + ${scenarios.length} scenarios`);
}

function sc_dim(scs: ScenarioSpec[]) {
  void scs;
  return { w: GEL_W, h: GEL_H };
}

main();
