import type { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult, BranchInfo, GelEvent, Material, ParamSet } from '../domain/types';
import { sha256Hex, stableId } from '../domain/hash';
import { GelBenchError } from '../domain/types';

export interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
  casepack_version: string | null;
}

export class Store {
  constructor(public db: DatabaseSync) {}

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow) ?? null;
  }

  createProject(id: string, name: string, createdAt: number, casepackVersion: string | null = null): void {
    this.db.prepare('INSERT INTO projects(id, name, created_at, casepack_version) VALUES(?,?,?,?)').run(id, name, createdAt, casepackVersion);
  }

  putImage(sha: string, bytes: Uint8Array, width: number, height: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO image_blobs(sha256, bytes, width, height) VALUES(?,?,?,?)')
      .run(sha, Buffer.from(bytes), width, height);
  }

  getImage(sha: string): { bytes: Uint8Array; width: number; height: number } | null {
    const row = this.db.prepare('SELECT bytes, width, height FROM image_blobs WHERE sha256 = ?').get(sha) as
      | { bytes: Uint8Array; width: number; height: number }
      | undefined;
    if (!row) return null;
    return { bytes: new Uint8Array(row.bytes), width: row.width, height: row.height };
  }

  putMaterial(m: Material): void {
    this.db
      .prepare('INSERT OR REPLACE INTO materials(id, project_id, kind, origin, supersedes, data) VALUES(?,?,?,?,?,?)')
      .run(m.id, m.projectId, m.kind, m.origin, m.supersedes, JSON.stringify(m));
  }

  getMaterial(id: string): Material | null {
    const row = this.db.prepare('SELECT data FROM materials WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Material) : null;
  }

  listMaterials(projectId: string): Material[] {
    const rows = this.db.prepare('SELECT data FROM materials WHERE project_id = ?').all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Material);
  }

  putParam(p: ParamSet): void {
    this.db
      .prepare('INSERT OR REPLACE INTO params(id, project_id, version, data) VALUES(?,?,?,?)')
      .run(p.id, p.projectId, p.version, JSON.stringify(p));
  }

  listParams(projectId: string): ParamSet[] {
    const rows = this.db.prepare('SELECT data FROM params WHERE project_id = ?').all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ParamSet);
  }

  putBranch(b: BranchInfo): void {
    this.db
      .prepare('INSERT OR REPLACE INTO branches(id, project_id, name, parent_branch_id, fork_event_id, created_at) VALUES(?,?,?,?,?,?)')
      .run(b.id, b.projectId, b.name, b.parentBranchId, b.forkEventId, b.createdAt);
  }

  listBranches(projectId: string): BranchInfo[] {
    const rows = this.db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_at').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      parentBranchId: (r.parent_branch_id as string) ?? null,
      forkEventId: (r.fork_event_id as string) ?? null,
      createdAt: r.created_at as number
    }));
  }

  appendEvent(e: GelEvent): void {
    this.db
      .prepare(
        `INSERT INTO events(id, project_id, seq, branch_id, parent_event_id, type, timestamp, actor, param_version, payload, summary)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(e.id, e.projectId, e.seq, e.branchId, e.parentEventId, e.type, e.timestamp, e.actor, e.paramVersion, JSON.stringify(e.payload), e.summary);
  }

  listEvents(projectId: string): GelEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY seq').all(projectId) as Record<string, unknown>[];
    return rows.map(deserializeEvent);
  }

  putResult(r: AnalysisResult): void {
    this.db
      .prepare('INSERT OR REPLACE INTO results(id, project_id, branch_id, basis_event_id, data) VALUES(?,?,?,?,?)')
      .run(r.id, r.projectId, r.branchId, r.basisEventId, JSON.stringify(r));
  }

  listResults(projectId: string, branchId?: string): AnalysisResult[] {
    const rows = branchId
      ? (this.db.prepare('SELECT data FROM results WHERE project_id = ? AND branch_id = ?').all(projectId, branchId) as { data: string }[])
      : (this.db.prepare('SELECT data FROM results WHERE project_id = ?').all(projectId) as { data: string }[]);
    return rows.map((r) => JSON.parse(r.data) as AnalysisResult);
  }

  putArchive(projectId: string, data: unknown): string {
    const id = stableId('ar', [projectId, JSON.stringify(data).length, Date.now()]);
    this.db.prepare('INSERT OR REPLACE INTO archives(id, project_id, data, created_at) VALUES(?,?,?,?)').run(id, projectId, JSON.stringify(data), Date.now());
    return id;
  }

  listArchives(projectId: string): unknown[] {
    const rows = this.db.prepare('SELECT data FROM archives WHERE project_id = ? ORDER BY created_at').all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  deleteProject(projectId: string): void {
    for (const table of ['results', 'events', 'materials', 'params', 'branches', 'archives', 'projects']) {
      if (table === 'projects') this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(projectId);
      else this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
  }
}

function deserializeEvent(r: Record<string, unknown>): GelEvent {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    seq: r.seq as number,
    branchId: r.branch_id as string,
    parentEventId: (r.parent_event_id as string) ?? null,
    type: r.type as GelEvent['type'],
    timestamp: r.timestamp as number,
    actor: r.actor as string,
    paramVersion: (r.param_version as number) ?? null,
    payload: JSON.parse(r.payload as string),
    summary: r.summary as string
  };
}
