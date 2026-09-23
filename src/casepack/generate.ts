/**
 * 生成离线案例包：casepack/gelbench-case.json（随仓库交付，非运行时联网下载）。
 * 运行：node --experimental-strip-types src/casepack/generate.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './builder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../casepack/gelbench-case.json');
mkdirSync(dirname(out), { recursive: true });
const { bundle } = buildBundle();
writeFileSync(out, JSON.stringify(bundle), 'utf8');
console.log(
  `案例包已生成 ${out}: ${bundle.events.length} 个事件, ${Object.keys(bundle.branchHeads).length} 条分支, ${Object.keys(bundle.images).length} 张图像`,
);
