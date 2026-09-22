import type { DatabaseSync } from 'node:sqlite';
import type {
  BandMark,
  CalibrationParams,
  Decision,
  DerivedNode,
  EventBase,
  ImageMaterial,
  LadderSpec,
  LaneGeometry,
  Material,
} from '../../shared/types.js';
import { ledgerTransaction, type SimulatedCrash } from './db.js';

export interface CaseRow {
  id: string;
  title: string;
  narrative: string;
  created_at: string;
  archived_at: string | null;
}

export class Repository {
  constructor(public db: DatabaseSync) {}

  // ---- meta ----
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
      .run(key, value);
  }

  // ---- blobs ----
  putBlob(key: string, bytes: Buffer, sha256: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO blobs(key,bytes,sha256,created_at) VALUES(?,?,?,?)')
      .run(key, bytes, sha256, new Date(0).toISOString());
  }
  getBlob(key: string): { bytes: Buffer; sha256: string } | null {
    const row = this.db.prepare('SELECT bytes, sha256 FROM blobs WHERE key=?').get(key) as
      | { bytes: Buffer; sha256: string }
      | undefined;
    return row ? { bytes: Buffer.from(row.bytes as Uint8Array), sha256: row.sha256 } : null;
  }

  // ---- cases ----
  upsertCase(row: CaseRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cases(id,title,narrative,created_at,archived_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(row.id, row.title, row.narrative, row.created_at, row.archived_at);
  }
  listCases(): CaseRow[] {
    return this.db
      .prepare('SELECT * FROM cases ORDER BY created_at, id')
      .all() as CaseRow[];
  }
  getCase(id: string): CaseRow | null {
    return (this.db.prepare('SELECT * FROM cases WHERE id=?').get(id) as CaseRow | undefined) ?? null;
  }
  deleteCase(id: string): void {
    this.db.prepare('DELETE FROM cases WHERE id=?').run(id);
    this.db.prepare('DELETE FROM materials WHERE case_id=?').run(id);
    this.db.prepare('DELETE FROM params WHERE case_id=?').run(id);
    this.db.prepare('DELETE FROM derived WHERE case_id=?').run(id);
    this.db.prepare('DELETE FROM events WHERE case_id=?').run(id);
    this.db.prepare('DELETE FROM decisions WHERE case_id=?').run(id);
    this.db.prepare('DELETE FROM write_ledger WHERE case_id=?').run(id);
  }

  // ---- materials ----
  putMaterial(m: Material): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO materials(id,case_id,kind,json,created_at) VALUES(?,?,?,?,?)',
      )
      .run(m.id, m.caseId, m.kind, JSON.stringify(m), (m as { createdAt?: string }).createdAt ?? new Date(0).toISOString());
  }
  listMaterials(caseId: string): Material[] {
    const rows = this.db
      .prepare('SELECT json FROM materials WHERE case_id=? ORDER BY id')
      .all(caseId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Material);
  }
  listMaterialsByKind<K extends Material['kind']>(
    caseId: string,
    kind: K,
  ): Extract<Material, { kind: K }>[] {
    const rows = this.db
      .prepare('SELECT json FROM materials WHERE case_id=? AND kind=? ORDER BY id')
      .all(caseId, kind) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Extract<Material, { kind: K }>);
  }
  getMaterial(id: string): Material | null {
    const row = this.db.prepare('SELECT json FROM materials WHERE id=?').get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Material) : null;
  }

  // ---- params ----
  putParams(p: CalibrationParams): void {
    this.db
      .prepare('INSERT OR REPLACE INTO params(id,case_id,version,json,created_at) VALUES(?,?,?,?,?)')
      .run(p.id, p.caseId, p.version, JSON.stringify(p), p.createdAt);
  }
  listParams(caseId: string): CalibrationParams[] {
    return (this.db.prepare('SELECT json FROM params WHERE case_id=? ORDER BY version').all(caseId) as Array<{ json: string }>).map(
      (r) => JSON.parse(r.json) as CalibrationParams,
    );
  }
  latestParams(caseId: string): CalibrationParams | null {
    const row = this.db
      .prepare('SELECT json FROM params WHERE case_id=? ORDER BY version DESC LIMIT 1')
      .get(caseId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CalibrationParams) : null;
  }

  // ---- derived ----
  putDerived(d: DerivedNode): void {
    this.db
      .prepare('INSERT OR REPLACE INTO derived(id,case_id,json,created_at) VALUES(?,?,?,?)')
      .run(d.id, d.caseId, JSON.stringify(d), d.createdAt);
  }
  listDerived(caseId: string): DerivedNode[] {
    return (this.db.prepare('SELECT json FROM derived WHERE case_id=? ORDER BY created_at,id').all(caseId) as Array<{ json: string }>).map(
      (r) => JSON.parse(r.json) as DerivedNode,
    );
  }
  getDerived(id: string): DerivedNode | null {
    const row = this.db.prepare('SELECT json FROM derived WHERE id=?').get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as DerivedNode) : null;
  }

  // ---- events (append-only) ----
  appendEvent(e: EventBase, withinTx?: DatabaseSync): void {
    const conn = withinTx ?? this.db;
    conn
      .prepare(
        `INSERT INTO events(id,case_id,seq,branch,parent_event_id,type,json,recorded_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(e.id, e.caseId, e.seq, e.branch, e.parentEventId, e.type, JSON.stringify(e), e.recordedAt);
  }
  listEvents(caseId: string): EventBase[] {
    return (
      this.db
        .prepare('SELECT json FROM events WHERE case_id=? ORDER BY branch, seq')
        .all(caseId) as Array<{ json: string }>
    ).map((r) => JSON.parse(r.json) as EventBase);
  }
  nextSeq(caseId: string, branch: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE case_id=? AND branch=?')
      .get(caseId, branch) as { n: number };
    return row.n;
  }

  // ---- decisions ----
  putDecision(d: Decision): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO decisions(id,case_id,branch,event_seq,json,recorded_at) VALUES(?,?,?,?,?,?)',
      )
      .run(d.id, d.caseId, d.branch, d.eventSeq, JSON.stringify(d), d.recordedAt);
  }
  listDecisions(caseId: string): Decision[] {
    return (this.db.prepare('SELECT json FROM decisions WHERE case_id=? ORDER BY branch,event_seq').all(caseId) as Array<{ json: string }>).map(
      (r) => JSON.parse(r.json) as Decision,
    );
  }

  /** 事务化写入：事件 + 决定/参数/派生统一在账本事务内 */
  transactional(
    txId: string,
    caseId: string,
    payload: string,
    body: (tx: DatabaseSync) => void,
    opts: { crashAfterPrepare?: boolean } = {},
  ): void {
    ledgerTransaction(this.db, txId, caseId, payload, body, opts);
  }
}

export type { SimulatedCrash };
