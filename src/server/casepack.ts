import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, ok, type Outcome, type Diagnostic } from '../shared/diagnostic';
import { sha256Hex } from '../shared/ids';
import type { Material } from '../shared/types';

export interface CasePack {
  dir: string;
  manifest: { packId: string; version: number; files: Record<string, { sha256: string }> };
  groundTruth: any;
  scenarios: any[];
  replay: any[];
}

/** 载入并校验案例包：任何文件哈希不符 => format-corrupt，并给出文件级位置 */
export function loadCasePack(dir: string): Outcome<CasePack> {
  const diagnostics: Diagnostic[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return fail('format-corrupt', [{
      severity: 'error', code: 'casepack/missing-manifest',
      message: `案例包缺少 manifest.json`, path: manifestPath,
    }]);
  }
  let manifest: CasePack['manifest'];
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return fail('format-corrupt', [{
      severity: 'error', code: 'casepack/manifest-parse',
      message: `manifest.json 解析失败：${(err as Error).message}`,
      path: manifestPath,
    }]);
  }
  for (const [file, meta] of Object.entries(manifest.files)) {
    const p = join(dir, file);
    if (!existsSync(p)) {
      diagnostics.push({
        severity: 'error', code: 'casepack/missing-file',
        message: `案例包缺少文件 ${file}`, path: p,
      });
      continue;
    }
    const actual = sha256Hex(readFileSync(p));
    if (actual !== meta.sha256) {
      diagnostics.push({
        severity: 'error', code: 'casepack/hash-mismatch',
        message: `文件 ${file} 校验和不符（期望 ${meta.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
        path: p,
      });
    }
  }
  if (diagnostics.length > 0) return fail('format-corrupt', diagnostics);
  return ok({
    dir,
    manifest,
    groundTruth: JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf8')),
    scenarios: JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8')),
    replay: JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')),
  });
}
