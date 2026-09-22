import type { DatabaseSync } from 'node:sqlite';
import { digestOf, newId } from '../domain/core';

export interface MaterialRow {
  id: string;
  identity: string;
  version: number;
  project_id: string;
  branch_id: string;
  type: string;
  json: string;
  digest: string;
  supersedes: string | null;
  created_seq: number;
}

export interface ComputationRow {
  id: string;
  identity: string;
  version: number;
  project_id: string;
  branch_id: string;
  kind: string;
  input_digest: string;
  param_version: string;
  parent_ids: string; // JSON
  output: string; // JSON
  created_seq: number;
}

export interface DecisionRow {
  id: string;
  project_id: string;
  branch_id: string;
  type: string;
  target_identity: string;
  json: string;
  created_seq: number;
}

export interface EventRow {
  seq: number;
  id: string;
  project_id: string;
  branch_id: string;
  kind: string;
  payload: string;
  parents: string;
  created_at: string;
}

export class Repo {
  constructor(private db: DatabaseSync) {}

  nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM events').get() as { s: number };
    return row.s;
  }

  createProject(name: string, id = newId('prj')): string {
    const seq = this.nextSeq();
    this.db.prepare('INSERT INTO projects(id, name, created_seq) VALUES (?, ?, ?)').run(id, name, seq);
    this.db.prepare('INSERT INTO branches(id, project_id, name, created_seq) VALUES (?, ?, ?, ?)').run('main', id, 'main', seq);
    return id;
  }

  listProjects(): { id: string; name: string }[] {
    return this.db.prepare('SELECT id, name FROM projects ORDER BY created_seq').all() as unknown as { id: string; name: string }[];
  }

  appendEvent(projectId: string, branchId: string, kind: string, payload: unknown, parents: string[] = []): EventRow {
    const seq = this.nextSeq();
    const ev: EventRow = {
      seq,
      id: newId('evt'),
      project_id: projectId,
      branch_id: branchId,
      kind,
      payload: JSON.stringify(payload),
      parents: JSON.stringify(parents),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO events(seq, id, project_id, branch_id, kind, payload, parents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ev.seq, ev.id, ev.project_id, ev.branch_id, ev.kind, ev.payload, ev.parents, ev.created_at);
    return ev;
  }

  /** 追加材料新版本（不可变层：旧版本行永不修改） */
  addMaterial(m: { identity?: string; projectId: string; branchId?: string; type: string; data: unknown; supersedes?: string | null }): MaterialRow {
    const identity = m.identity ?? newId('mat');
    const prev = this.latestMaterial(identity);
    const version = prev ? prev.version + 1 : 1;
    const seq = this.nextSeq();
    const row: MaterialRow = {
      id: newId('mv'),
      identity,
      version,
      project_id: m.projectId,
      branch_id: m.branchId ?? 'main',
      type: m.type,
      json: JSON.stringify(m.data),
      digest: digestOf(m.data),
      supersedes: m.supersedes ?? (prev ? prev.id : null),
      created_seq: seq,
    };
    this.db
      .prepare('INSERT INTO materials(id, identity, version, project_id, branch_id, type, json, digest, supersedes, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.identity, row.version, row.project_id, row.branch_id, row.type, row.json, row.digest, row.supersedes, row.created_seq);
    return row;
  }

  latestMaterial(identity: string, asOf?: number): MaterialRow | null {
    const rows = this.db
      .prepare('SELECT * FROM materials WHERE identity = ? AND created_seq <= ? ORDER BY version DESC LIMIT 1')
      .all(identity, asOf ?? Number.MAX_SAFE_INTEGER) as unknown as MaterialRow[];
    return rows[0] ?? null;
  }

  /** 某项目在某 seq 之前的全部材料当前版本 */
  materialsAt(projectId: string, asOf?: number): MaterialRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM materials m
         JOIN (SELECT identity, MAX(version) AS v FROM materials WHERE project_id = ? AND created_seq <= ? GROUP BY identity) latest
           ON latest.identity = m.identity AND latest.v = m.version
         WHERE m.project_id = ? ORDER BY m.identity`,
      )
      .all(projectId, asOf ?? Number.MAX_SAFE_INTEGER, projectId) as unknown as MaterialRow[];
  }

  addComputation(c: {
    identity: string;
    projectId: string;
    branchId?: string;
    kind: string;
    inputDigest: string;
    paramVersion: string;
    parentIds: { identity: string; version: number }[];
    output: unknown;
  }): ComputationRow {
    const prev = this.latestComputation(c.identity);
    const version = prev ? prev.version + 1 : 1;
    const seq = this.nextSeq();
    const row: ComputationRow = {
      id: newId('cmp'),
      identity: c.identity,
      version,
      project_id: c.projectId,
      branch_id: c.branchId ?? 'main',
      kind: c.kind,
      input_digest: c.inputDigest,
      param_version: c.paramVersion,
      parent_ids: JSON.stringify(c.parentIds),
      output: JSON.stringify(c.output),
      created_seq: seq,
    };
    this.db
      .prepare(
        'INSERT INTO computations(id, identity, version, project_id, branch_id, kind, input_digest, param_version, parent_ids, output, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.identity, row.version, row.project_id, row.branch_id, row.kind, row.input_digest, row.param_version, row.parent_ids, row.output, row.created_seq);
    return row;
  }

  latestComputation(identity: string, asOf?: number): ComputationRow | null {
    const rows = this.db
      .prepare('SELECT * FROM computations WHERE identity = ? AND created_seq <= ? ORDER BY version DESC LIMIT 1')
      .all(identity, asOf ?? Number.MAX_SAFE_INTEGER) as unknown as ComputationRow[];
    return rows[0] ?? null;
  }

  computationsAt(projectId: string, asOf?: number): ComputationRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM computations c
         JOIN (SELECT identity, MAX(version) AS v FROM computations WHERE project_id = ? AND created_seq <= ? GROUP BY identity) latest
           ON latest.identity = c.identity AND latest.v = c.version
         WHERE c.project_id = ? ORDER BY c.identity`,
      )
      .all(projectId, asOf ?? Number.MAX_SAFE_INTEGER, projectId) as unknown as ComputationRow[];
  }

  addDecision(d: { projectId: string; branchId?: string; type: string; targetIdentity: string; data: unknown }): DecisionRow {
    const seq = this.nextSeq();
    const row: DecisionRow = {
      id: newId('dec'),
      project_id: d.projectId,
      branch_id: d.branchId ?? 'main',
      type: d.type,
      target_identity: d.targetIdentity,
      json: JSON.stringify(d.data),
      created_seq: seq,
    };
    this.db
      .prepare('INSERT INTO decisions(id, project_id, branch_id, type, target_identity, json, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.project_id, row.branch_id, row.type, row.target_identity, row.json, row.created_seq);
    return row;
  }

  decisionsAt(projectId: string, asOf?: number): DecisionRow[] {
    return this.db
      .prepare('SELECT * FROM decisions WHERE project_id = ? AND created_seq <= ? ORDER BY created_seq')
      .all(projectId, asOf ?? Number.MAX_SAFE_INTEGER) as unknown as DecisionRow[];
  }

  events(projectId: string, asOf?: number): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE project_id = ? AND seq <= ? ORDER BY seq')
      .all(projectId, asOf ?? Number.MAX_SAFE_INTEGER) as unknown as EventRow[];
  }

  /** 导出：完整快照（身份、顺序、来源关系原样保留） */
  exportProject(projectId: string) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    if (!project) return null;
    const branches = this.db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_seq').all(projectId);
    const materials = this.db.prepare('SELECT * FROM materials WHERE project_id = ? ORDER BY created_seq, id').all(projectId);
    const computations = this.db.prepare('SELECT * FROM computations WHERE project_id = ? ORDER BY created_seq, id').all(projectId);
    const decisions = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_seq, id').all(projectId);
    const events = this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY seq').all(projectId);
    const bundle = {
      format: 'gel-scale-export',
      formatVersion: 1,
      project,
      branches,
      materials,
      computations,
      decisions,
      events,
    };
    return { ...bundle, digest: digestOf(bundle) };
  }
}
