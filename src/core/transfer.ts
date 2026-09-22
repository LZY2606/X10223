import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import type { GelBundle, GelEvent } from '../shared/types';
import type { DB } from './db';
import { ProjectStore } from './store';
import { GelFailure, diag } from './errors';
import { sha256Hex } from './digest';

/**
 * 导出/导入：身份、顺序、分支、决定历史、blob 字节全部保留。
 * 导入在单个事务内完成；任何失败整体回滚（半写不污染既有库）。
 */
export function exportProject(db: DB, projectId: string, exportedAtUtcIso = new Date().toISOString()): GelBundle {
  const store = new ProjectStore(db, projectId);
  const project = db.prepare('SELECT name FROM projects WHERE project_id = ?').get(projectId) as { name: string } | undefined;
  if (!project) throw new Error(`project ${projectId} 不存在`);
  const events = store.events();
  const blobs = store.listBlobs().map((b) => {
    const full = store.getBlob(b.uri)!;
    return {
      uri: b.uri,
      sha256: b.sha256,
      mediaType: b.mediaType,
      base64: Buffer.from(full.bytes).toString('base64'),
    };
  });
  return {
    format: 'gel-lane-ruler/bundle',
    formatVersion: 1,
    projectId,
    projectName: project.name,
    exportedAtUtcIso,
    events,
    blobs,
  };
}

export function verifyBundle(raw: unknown): { bundle: GelBundle; diagnostics: { code: string; message: string }[] } {
  const diagnostics: { code: string; message: string }[] = [];
  if (typeof raw !== 'object' || raw === null) {
    throw new GelFailure('FORMAT_CORRUPT', [diag('FORMAT_CORRUPT', 'error', '导出包不是 JSON 对象', {})]);
  }
  const bundle = raw as Partial<GelBundle>;
  if (bundle.format !== 'gel-lane-ruler/bundle' || bundle.formatVersion !== 1) {
    throw new GelFailure('FORMAT_CORRUPT', [
      diag('FORMAT_CORRUPT', 'error', `无法识别的格式：${String(bundle.format)} v${String(bundle.formatVersion)}`, {}),
    ]);
  }
  if (!bundle.projectId || typeof bundle.projectName !== 'string' || !Array.isArray(bundle.events) || !Array.isArray(bundle.blobs)) {
    throw new GelFailure('FORMAT_CORRUPT', [diag('FORMAT_CORRUPT', 'error', '导出包缺少 projectId / events / blobs 等必需字段', {})]);
  }

  // 顺序、链指针、摘要全部校验；身份原样保留
  const byBranch = new Map<string, GelEvent[]>();
  for (const e of bundle.events) {
    if (!e.eventId || !e.branch || typeof e.branchSeq !== 'number') {
      throw new GelFailure('FORMAT_CORRUPT', [diag('FORMAT_CORRUPT', 'error', '事件缺少稳定身份或顺序字段', {})]);
    }
    const list = byBranch.get(e.branch) ?? [];
    list.push(e);
    byBranch.set(e.branch, list);
  }
  for (const [branch, events] of byBranch) {
    events.sort((a, b) => a.branchSeq - b.branchSeq);
    let prev: string | null = null;
    for (const e of events) {
      if (e.prevEventId !== prev) {
        throw new GelFailure('FORMAT_CORRUPT', [
          diag('FORMAT_CORRUPT', 'error', `分支 ${branch} 事件链在 ${e.eventId} 处断裂（半写？）`, { branch }),
        ]);
      }
      prev = e.eventId;
    }
  }
  for (const blob of bundle.blobs) {
    const bytes = Buffer.from(blob.base64, 'base64');
    const actual = sha256Hex(bytes);
    if (actual !== blob.sha256) {
      throw new GelFailure('FORMAT_CORRUPT', [
        diag('FORMAT_CORRUPT', 'error', `blob ${blob.uri} 的 sha256 不匹配（字节被截断或损坏）`, { path: blob.uri }),
      ]);
    }
  }
  return { bundle: bundle as GelBundle, diagnostics };
}

export interface ImportResult {
  projectId: string;
  events: number;
  blobs: number;
  replaced: boolean;
}

export function importProject(
  db: DB,
  bundle: GelBundle,
  opts: { replace?: boolean; wallTimeUtcIso?: string } = {}
): ImportResult {
  verifyBundle(bundle);
  const exists = db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(bundle.projectId);
  if (exists && !opts.replace) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('CONFLICTING_DECISIONS', 'error', `项目 ${bundle.projectId} 已存在；导入不会静默合并或覆盖`, { branch: bundle.projectId }),
    ]);
  }

  const tx = db.exec.bind(db);
  tx('BEGIN IMMEDIATE');
  try {
    if (exists) {
      db.prepare('DELETE FROM events WHERE project_id = ?').run(bundle.projectId);
      db.prepare('DELETE FROM blobs WHERE project_id = ?').run(bundle.projectId);
      db.prepare('DELETE FROM branches WHERE project_id = ?').run(bundle.projectId);
      db.prepare('DELETE FROM projects WHERE project_id = ?').run(bundle.projectId);
    }
    db.prepare('INSERT INTO projects(project_id, name, created_at_utc, case_pack_version) VALUES(?,?,?,?)').run(
      bundle.projectId,
      bundle.projectName,
      bundle.exportedAtUtcIso,
      bundle.casePack?.casePackVersion ?? null
    );

    const branchesSeen = new Set<string>();
    for (const e of [...bundle.events].sort((a, b) => a.seq - b.seq)) {
      if (e.type === 'projectCreated') continue;
      if (e.type === 'branchCreated') {
        const p = e.payload as GelEvent['payload'] & { name: string; parentBranch: string; parentEventId: string };
        if (!branchesSeen.has(p.name)) {
          db.prepare(
            'INSERT OR REPLACE INTO branches(project_id, name, parent_branch, parent_event_id, created_clock) VALUES(?,?,?,?,?)'
          ).run(bundle.projectId, p.name, p.parentBranch, p.parentEventId, e.logicalClock);
          branchesSeen.add(p.name);
        }
      }
      db.prepare(
        `INSERT INTO events(event_id, project_id, seq, branch, branch_seq, prev_event_id, type, payload_json, logical_clock, wall_time_utc, digest)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        e.eventId,
        bundle.projectId,
        e.seq,
        e.branch,
        e.branchSeq,
        e.prevEventId,
        e.type,
        JSON.stringify(e.payload),
        e.logicalClock,
        e.wallTimeUtcIso,
        e.digest
      );
    }
    if (!branchesSeen.has('main')) {
      db.prepare(
        'INSERT OR REPLACE INTO branches(project_id, name, parent_branch, parent_event_id, created_clock) VALUES(?,?,?,?,?)'
      ).run(bundle.projectId, 'main', null, null, 1);
    }
    for (const blob of bundle.blobs) {
      db.prepare('INSERT INTO blobs(project_id, uri, sha256, media_type, bytes) VALUES(?,?,?,?,?)').run(
        bundle.projectId,
        blob.uri,
        blob.sha256,
        blob.mediaType,
        Buffer.from(blob.base64, 'base64')
      );
    }
    tx('COMMIT');
  } catch (err) {
    tx('ROLLBACK');
    throw err;
  }

  void ProjectStore;
  void opts;
  return { projectId: bundle.projectId, events: bundle.events.length, blobs: bundle.blobs.length, replaced: !!exists };
}

/**
 * 半写恢复：导入先写暂存文件，崩溃/截断时不替换正式文件。
 * 重启时调用本函数：发现暂存 -> 记录 halfWriteDetected 诊断并丢弃暂存。
 */
export function atomicWriteBundleFile(targetPath: string, bundle: GelBundle) {
  const staging = `${targetPath}.staging`;
  writeFileSync(staging, JSON.stringify(bundle));
  renameSync(staging, targetPath);
}

export function recoverStagingBundle(
  stagingPath: string,
  db: DB,
  projectId: string,
  branch = 'main',
  clock?: number
): { recovered: boolean; bytes: number } {
  if (!existsSync(stagingPath)) return { recovered: false, bytes: 0 };
  const bytes = readFileSync(stagingPath);
  let parseOk = true;
  try {
    verifyBundle(JSON.parse(bytes.toString('utf8')));
  } catch {
    parseOk = false;
  }
  const store = new ProjectStore(db, projectId);
  store.append(
    branch,
    'halfWriteDetected',
    {
      stagingUri: stagingPath,
      bytesSeen: bytes.length,
      detail: parseOk ? '暂存内容完整但未提交（缺正式文件）' : '暂存 JSON 截断/校验失败，已丢弃',
    },
    { logicalClock: clock }
  );
  // 正式文件若缺失，则暂存不提升；明确删除以终止半写状态
  rmSync(stagingPath, { force: true });
  return { recovered: true, bytes: bytes.length };
}
