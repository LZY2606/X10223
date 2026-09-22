import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCasePack } from '../src/domain/casepack';
import { sha256Hex } from '../src/domain/ids';

const outDir = resolve(process.cwd(), 'cases');
mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(outDir, 'images'), { recursive: true });

const pack = buildCasePack();
for (const [name, buf] of Object.entries(pack.files)) {
  writeFileSync(resolve(outDir, 'images', name), buf);
}

const manifest = {
  ...pack.spec,
  files: Object.fromEntries(
    Object.entries(pack.files).map(([name, buf]) => [name, { sha256: sha256Hex(buf.toString('binary')), bytes: buf.length }])
  ),
};
writeFileSync(resolve(outDir, 'case-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`案例包已生成：${Object.keys(pack.files).length} 张凝胶图 + case-manifest.json`);
