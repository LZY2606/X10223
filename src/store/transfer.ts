import type { DatabaseSync } from 'node:sqlite';
import { digestOf, type Diagnostic, type Result } from '../domain/core';
import { fail, ok } from '../domain/core';

export interface ImportOutcome {
  projectId: string;
  inserted: { materials: number; computations: number; decisions: number; events: number };
  skipped: number; // 幂等：已存在的行跳过
}

export interface ImportOptions {
  /** 测试用：在第 N 条写入后注入故障，验证半写恢复 */
  failAfterWrites?: number;
}

const TABLES: { name: string; cols: string[] }[] = [
  { name: 'projects', cols: ['id', 'name', 'created_seq'] },
  { name: 'branches', cols: ['id', 'project_id', 'name', 'created_seq'] },
  { name: 'materials', cols: ['id', 'identity', 'version', 'project_id', 'branch_id', 'type', 'json', 'digest', 'supersedes', 'created_seq'] },
  { name: 'computations', cols: ['id', 'identity', 'version', 'project_id', 'branch_id', 'kind', 'input_digest', 'param_version', 'parent_ids', 'output', 'created_seq'] },
  { name: 'decisions', cols: ['id', 'project_id', 'branch_id', 'type', 'target_identity', 'json', 'created_seq'] },
  { name: 'events', cols: ['seq', 'id', 'project_id', 'branch_id', 'kind', 'payload', 'parents', 'created_at'] },
];

function validateBundle(bundle: unknown): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (typeof bundle !== 'object' || bundle === null) {
    diags.push({ code: 'IMPORT_NOT_OBJECT', message: '导入内容不是 JSON 对象' });
    return diags;
  }
  const b = bundle as Record<string, unknown>;
  if (b.format !== 'gel-scale-export') diags.push({ code: 'IMPORT_BAD_FORMAT', message: `format 字段应为 gel-scale-export，实际 ${JSON.stringify(b.format)}`, location: { field: 'format' } });
  if (b.formatVersion !== 1) diags.push({ code: 'IMPORT_BAD_VERSION', message: `formatVersion 不支持：${JSON.stringify(b.formatVersion)}`, location: { field: 'formatVersion' } });
  for (const key of ['project', 'branches', 'materials', 'computations', 'decisions', 'events']) {
    if (b[key] === undefined) diags.push({ code: 'IMPORT_MISSING_SECTION', message: `缺少段落 ${key}`, location: { field: key } });
  }
  if (diags.length > 0) return diags;
  const { digest, ...rest } = b;
  if (typeof digest !== 'string' || digestOf(rest) !== digest) {
    diags.push({ code: 'IMPORT_DIGEST_MISMATCH', message: '导出包摘要校验失败（内容损坏或被篡改）', location: { field: 'digest' } });
  }
  return diags;
}

/**
 * 导入：单事务、幂等（身份冲突跳过）、失败整体回滚（半写恢复）。
 * 格式损坏返回 format_corrupt，与语义无解、资源耗尽严格区分。
 */
export function importProject(db: DatabaseSync, raw: string, opts: ImportOptions = {}): Result<ImportOutcome> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch (e) {
    return fail('format_corrupt', [{ code: 'IMPORT_JSON_PARSE', message: `JSON 解析失败：${(e as Error).message}` }]);
  }
  const diags = validateBundle(bundle);
  if (diags.length > 0) return fail('format_corrupt', diags);

  const b = bundle as Record<string, unknown>;
  const projectId = (b.project as { id: string }).id;
  const inserted = { materials: 0, computations: 0, decisions: 0, events: 0 };
  let skipped = 0;
  let writes = 0;

  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      const rows = (b[t.name === 'projects' ? 'project' : t.name] ?? (t.name === 'projects' ? [] : [])) as Record<string, unknown> | Record<string, unknown>[];
      const list = Array.isArray(rows) ? rows : [rows];
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${t.name}(${t.cols.join(',')}) VALUES (${t.cols.map(() => '?').join(',')})`);
      for (const row of list) {
        const values = t.cols.map((c) => {
          const v = row[c];
          if (v === undefined) throw new Error(`row missing column ${c} in ${t.name}`);
          return v as string | number | null;
        });
        const res = stmt.run(...values);
        writes++;
        if (opts.failAfterWrites !== undefined && writes > opts.failAfterWrites) {
          throw new Error('INJECTED_IMPORT_FAILURE');
        }
        if (Number(res.changes) > 0) {
          if (t.name === 'materials') inserted.materials++;
          else if (t.name === 'computations') inserted.computations++;
          else if (t.name === 'decisions') inserted.decisions++;
          else if (t.name === 'events') inserted.events++;
        } else {
          skipped++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if ((e as Error).message === 'INJECTED_IMPORT_FAILURE') throw e;
    return fail('format_corrupt', [{ code: 'IMPORT_WRITE_FAILED', message: `写入失败，已整体回滚：${(e as Error).message}` }]);
  }
  return ok({ projectId, inserted, skipped });
}
