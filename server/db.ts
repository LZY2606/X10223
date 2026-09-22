import { DatabaseSync } from 'node:sqlite';
import {
  Computation,
  Decision,
  Material,
  ParamSet,
  WorkbenchEvent,
} from './domain/types';
import { eventId, hashContent } from './domain/ids';

export type CaseRow = {
  id: string;
  title: string;
  narrative: string;
  kind: 'baseline' | 'counterexample';
  meta: unknown;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL,
  kind TEXT NOT NULL,
  meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials(
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pixel_sources TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  supersedes TEXT
);
CREATE TABLE IF NOT EXISTS param_sets(
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computations(
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  param_version INTEGER NOT NULL,
  parents TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  valid_from_seq INTEGER NOT NULL,
  valid_to_seq INTEGER
);
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  note TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  parents TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mat_case ON materials(case_id);
CREATE INDEX IF NOT EXISTS idx_cmp_case ON computations(case_id);
CREATE INDEX IF NOT EXISTS idx_dec_case ON decisions(case_id);
CREATE INDEX IF NOT EXISTS idx_evt_case ON events(case_id);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // 事务包装：任何一步失败整体回滚，保证半写可恢复。
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  appendEvent(
    caseId: string,
    type: WorkbenchEvent['type'],
    payload: unknown,
    parents: string[] = [],
  ): WorkbenchEvent {
    const payloadText = JSON.stringify(payload);
    const stmt = this.db.prepare(
      'INSERT INTO events(case_id, id, type, payload, parents, created_at) VALUES (?,?,?,?,?,?)',
    );
    // 先取下一序号以保证事件 id 稳定可预测。
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM events').get() as { next: number };
    const id = eventId(row.next, type, hashContent(payload));
    stmt.run(caseId, id, type, payloadText, JSON.stringify(parents), new Date().toISOString());
    return { seq: row.next, id, caseId, type, payload, parents, createdAt: new Date().toISOString() };
  }

  insertCase(c: CaseRow): void {
    this.db
      .prepare('INSERT OR IGNORE INTO cases(id,title,narrative,kind,meta) VALUES (?,?,?,?,?)')
      .run(c.id, c.title, c.narrative, c.kind, JSON.stringify(c.meta));
  }

  listCases(): CaseRow[] {
    const rows = this.db.prepare('SELECT * FROM cases ORDER BY id').all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      narrative: r.narrative as string,
      kind: r.kind as CaseRow['kind'],
      meta: JSON.parse(r.meta as string),
    }));
  }

  insertMaterial(m: Material): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO materials(id,case_id,kind,version,content,content_hash,pixel_sources,created_seq,supersedes) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        m.id,
        m.caseId,
        m.kind,
        m.version,
        JSON.stringify(m.content),
        m.contentHash,
        JSON.stringify(m.pixelSources),
        m.createdSeq,
        m.supersedes,
      );
  }

  materials(caseId: string): Material[] {
    const rows = this.db
      .prepare('SELECT * FROM materials WHERE case_id=? ORDER BY created_seq, kind, id')
      .all(caseId) as unknown as Record<string, unknown>[];
    return rows.map(rowToMaterial);
  }

  material(id: string): Material | null {
    const r = this.db.prepare('SELECT * FROM materials WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToMaterial(r) : null;
  }

  insertParamSet(p: ParamSet): void {
    this.db
      .prepare('INSERT OR REPLACE INTO param_sets(id,case_id,version,content,created_seq) VALUES (?,?,?,?,?)')
      .run(p.id, p.caseId, p.version, JSON.stringify(p.content), p.createdSeq);
  }

  latestParamSet(caseId: string): ParamSet | null {
    const r = this.db
      .prepare('SELECT * FROM param_sets WHERE case_id=? ORDER BY version DESC LIMIT 1')
      .get(caseId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      caseId: r.case_id as string,
      version: r.version as number,
      content: JSON.parse(r.content as string),
      createdSeq: r.created_seq as number,
    };
  }

  paramSets(caseId: string): ParamSet[] {
    const rows = this.db
      .prepare('SELECT * FROM param_sets WHERE case_id=? ORDER BY version')
      .all(caseId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      caseId: r.case_id as string,
      version: r.version as number,
      content: JSON.parse(r.content as string),
      createdSeq: r.created_seq as number,
    }));
  }

  insertComputation(c: Computation): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO computations(id,case_id,kind,subject,input_digest,param_version,parents,status,output,diagnostics,valid_from_seq,valid_to_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        c.id,
        c.caseId,
        c.kind,
        c.subject,
        c.inputDigest,
        c.paramVersion,
        JSON.stringify(c.parents),
        c.status,
        JSON.stringify(c.output),
        JSON.stringify(c.diagnostics),
        c.validFromSeq,
        c.validToSeq,
      );
  }

  invalidateComputation(id: string, validToSeq: number): void {
    this.db.prepare('UPDATE computations SET valid_to_seq=? WHERE id=?').run(validToSeq, id);
  }

  computations(caseId: string, atSeq?: number): Computation[] {
    const rows = this.db
      .prepare('SELECT * FROM computations WHERE case_id=? ORDER BY kind, subject, valid_from_seq')
      .all(caseId) as unknown as Record<string, unknown>[];
    const all = rows.map(rowToComputation);
    if (atSeq === undefined) return all.filter((c) => c.validToSeq === null);
    return all.filter((c) => c.validFromSeq <= atSeq && (c.validToSeq === null || c.validToSeq > atSeq));
  }

  allComputations(caseId: string): Computation[] {
    const rows = this.db
      .prepare('SELECT * FROM computations WHERE case_id=? ORDER BY valid_from_seq, kind, subject')
      .all(caseId) as unknown as Record<string, unknown>[];
    return rows.map(rowToComputation);
  }

  insertDecision(d: Decision): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO decisions(id,case_id,branch_id,target_kind,target_id,action,payload,reviewer,note,created_seq) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(d.id, d.caseId, d.branchId, d.targetKind, d.targetId, d.action, JSON.stringify(d.payload), d.reviewer, d.note, d.createdSeq);
  }

  decisions(caseId: string, atSeq?: number): Decision[] {
    const rows = this.db
      .prepare('SELECT * FROM decisions WHERE case_id=? ORDER BY created_seq, id')
      .all(caseId) as unknown as Record<string, unknown>[];
    const all = rows.map(rowToDecision);
    if (atSeq === undefined) return all;
    return all.filter((d) => d.createdSeq <= atSeq);
  }

  events(caseId: string, atSeq?: number): WorkbenchEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE case_id=? ORDER BY seq')
      .all(caseId) as unknown as Record<string, unknown>[];
    const all = rows.map(rowToEvent);
    if (atSeq === undefined) return all;
    return all.filter((e) => e.seq <= atSeq);
  }

  maxSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM events').get() as { m: number };
    return r.m;
  }

  isSeeded(): boolean {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
    return r.n > 0;
  }

  clearAll(): void {
    this.transaction(() => {
      for (const t of ['events', 'decisions', 'computations', 'param_sets', 'materials', 'cases']) {
        this.db.exec(`DELETE FROM ${t}`);
      }
    });
  }
}

function rowToMaterial(r: Record<string, unknown>): Material {
  return {
    id: r.id as string,
    caseId: r.case_id as string,
    kind: r.kind as Material['kind'],
    version: r.version as number,
    content: JSON.parse(r.content as string),
    contentHash: r.content_hash as string,
    pixelSources: JSON.parse(r.pixel_sources as string),
    createdSeq: r.created_seq as number,
    supersedes: (r.supersedes as string | null) ?? null,
  };
}

function rowToComputation(r: Record<string, unknown>): Computation {
  return {
    id: r.id as string,
    caseId: r.case_id as string,
    kind: r.kind as Computation['kind'],
    subject: r.subject as string,
    inputDigest: r.input_digest as string,
    paramVersion: r.param_version as number,
    parents: JSON.parse(r.parents as string),
    status: r.status as Computation['status'],
    output: JSON.parse(r.output as string),
    diagnostics: JSON.parse(r.diagnostics as string),
    validFromSeq: r.valid_from_seq as number,
    validToSeq: (r.valid_to_seq as number | null) ?? null,
  };
}

function rowToDecision(r: Record<string, unknown>): Decision {
  return {
    id: r.id as string,
    caseId: r.case_id as string,
    branchId: r.branch_id as string,
    targetKind: r.target_kind as Decision['targetKind'],
    targetId: r.target_id as string,
    action: r.action as Decision['action'],
    payload: JSON.parse(r.payload as string),
    reviewer: r.reviewer as string,
    note: r.note as string,
    createdSeq: r.created_seq as number,
  };
}

function rowToEvent(r: Record<string, unknown>): WorkbenchEvent {
  return {
    seq: r.seq as number,
    id: r.id as string,
    caseId: r.case_id as string,
    type: r.type as WorkbenchEvent['type'],
    payload: JSON.parse(r.payload as string),
    parents: JSON.parse(r.parents as string),
    createdAt: r.created_at as string,
  };
}
