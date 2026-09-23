import type { DatabaseSync } from 'node:sqlite';
import type {
  ArchiveEntry,
  Computation,
  EventKind,
  Material,
  WbEvent,
} from '../shared/types';
import { eventId } from '../shared/canonical';

export interface ProjectRow {
  id: string;
  name: string;
  parentId: string | null;
  branchReason: string | null;
  createdSeq: number;
}

// 存储层：材料不可变（修订追加新 revision），事件追加式，计算内容寻址。
// 所有读取支持 as-of：传入 seq 即可恢复当时可见的依赖版本与结论。
export class Store {
  constructor(public readonly db: DatabaseSync) {}

  // --- projects ---
  addProject(id: string, name: string, parentId: string | null, branchReason: string | null, createdSeq = 0): void {
    this.db
      .prepare('INSERT INTO projects(id,name,parent_id,branch_reason,created_seq) VALUES(?,?,?,?,?)')
      .run(id, name, parentId, branchReason, createdSeq);
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db
      .prepare('SELECT id,name,parent_id,branch_reason,created_seq FROM projects WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      parentId: (r.parent_id as string | null) ?? null,
      branchReason: (r.branch_reason as string | null) ?? null,
      createdSeq: r.created_seq as number,
    };
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare('SELECT id,name,parent_id,branch_reason,created_seq FROM projects ORDER BY created_seq, id')
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      parentId: (r.parent_id as string | null) ?? null,
      branchReason: (r.branch_reason as string | null) ?? null,
      createdSeq: r.created_seq as number,
    }));
  }

  deleteProject(id: string): void {
    for (const t of ['materials', 'events', 'computations', 'archive']) {
      this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(id);
    }
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }

  // --- events ---
  nextSeq(projectId: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM events WHERE project_id=?').get(projectId) as { m: number | null };
    return (r.m ?? 0) + 1;
  }

  addEvent(
    projectId: string,
    kind: EventKind,
    payload: Record<string, unknown>,
    parents: string[],
    machineReadable?: { code: string; detail: Record<string, unknown> },
    forcedSeq?: number,
  ): WbEvent {
    const seq = forcedSeq ?? this.nextSeq(projectId);
    const slug = kind.toLowerCase().replace(/_/g, '-');
    const evt: WbEvent = {
      id: eventId(seq, slug),
      seq,
      kind,
      payload,
      parents: [...parents].sort(),
      ...(machineReadable ? { machineReadable } : {}),
    };
    const storedPayload = machineReadable ? { ...evt.payload, __machine: machineReadable } : evt.payload;
    this.db
      .prepare('INSERT INTO events(project_id,seq,id,kind,json,parents) VALUES(?,?,?,?,?,?)')
      .run(projectId, seq, evt.id, kind, JSON.stringify(storedPayload), JSON.stringify(evt.parents));
    return evt;
  }

  eventsAt(projectId: string, seq?: number): WbEvent[] {
    const rows = (
      seq === undefined
        ? this.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq').all(projectId)
        : this.db.prepare('SELECT * FROM events WHERE project_id=? AND seq<=? ORDER BY seq').all(projectId, seq)
    ) as Record<string, unknown>[];
    return rows.map((r) => {
      const payload = JSON.parse(r.json as string) as Record<string, unknown>;
      const evt: WbEvent = {
        id: r.id as string,
        seq: r.seq as number,
        kind: r.kind as EventKind,
        payload,
        parents: JSON.parse(r.parents as string) as string[],
      };
      const mr = payload.__machine as { code: string; detail: Record<string, unknown> } | undefined;
      if (mr) {
        evt.machineReadable = mr;
        delete payload.__machine;
      }
      return evt;
    });
  }

  // --- materials ---
  putMaterials(projectId: string, materials: Material[], seq: number): void {
    const stmt = this.db.prepare(
      'INSERT INTO materials(project_id,id,revision,supersedes,kind,seq,json) VALUES(?,?,?,?,?,?,?)',
    );
    for (const m of materials) {
      const supersedes = 'supersedes' in m ? (m.supersedes as string | null) : null;
      stmt.run(projectId, m.id, m.revision, supersedes ?? null, m.kind, seq, JSON.stringify(m));
    }
  }

  // 每个 id 在 as-of 时点取最新 revision；等价输入下顺序稳定（kind, id, revision）。
  materialsAt(projectId: string, seq?: number): Material[] {
    const bound = seq === undefined ? Number.MAX_SAFE_INTEGER : seq;
    const rows = this.db
      .prepare(
        `SELECT m.json FROM materials m
         JOIN (SELECT id, MAX(revision) AS rev FROM materials
               WHERE project_id=? AND seq<=? GROUP BY id) t
           ON m.id=t.id AND m.revision=t.rev
         WHERE m.project_id=? AND m.seq<=?
         ORDER BY m.kind, m.id, m.revision`,
      )
      .all(projectId, bound, projectId, bound) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Material);
  }

  materialById(projectId: string, id: string, seq?: number): Material | null {
    const bound = seq === undefined ? Number.MAX_SAFE_INTEGER : seq;
    const r = this.db
      .prepare(
        'SELECT json FROM materials WHERE project_id=? AND id=? AND seq<=? ORDER BY revision DESC LIMIT 1',
      )
      .get(projectId, id, bound) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Material) : null;
  }

  // --- computations ---
  putComputation(projectId: string, c: Computation): void {
    this.db
      .prepare('INSERT OR IGNORE INTO computations(project_id,id,kind,seq,valid_to,json) VALUES(?,?,?,?,NULL,?)')
      .run(projectId, c.id, c.kind, c.seq, JSON.stringify(c));
  }

  invalidateComputations(projectId: string, ids: string[], validTo: number): void {
    const stmt = this.db.prepare('UPDATE computations SET valid_to=? WHERE project_id=? AND id=?');
    for (const id of ids) stmt.run(validTo, projectId, id);
  }

  computationsAt(projectId: string, seq?: number): Computation[] {
    const bound = seq === undefined ? Number.MAX_SAFE_INTEGER : seq;
    const rows = this.db
      .prepare(
        `SELECT json FROM computations
         WHERE project_id=? AND seq<=? AND (valid_to IS NULL OR valid_to>?)
         ORDER BY kind, id`,
      )
      .all(projectId, bound, bound) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Computation);
  }

  allComputations(projectId: string): Computation[] {
    const rows = this.db
      .prepare('SELECT json FROM computations WHERE project_id=? ORDER BY seq, kind, id')
      .all(projectId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Computation);
  }

  // --- archive ---
  putArchiveEntry(projectId: string, entry: ArchiveEntry): void {
    this.db
      .prepare('INSERT OR REPLACE INTO archive(project_id,id,json) VALUES(?,?,?)')
      .run(projectId, entry.id, JSON.stringify(entry));
  }

  archiveAt(projectId: string): ArchiveEntry[] {
    const rows = this.db
      .prepare('SELECT json FROM archive WHERE project_id=? ORDER BY id')
      .all(projectId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ArchiveEntry);
  }
}
