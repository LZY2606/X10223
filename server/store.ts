import { DatabaseSync } from 'node:sqlite';
import { contentId, eventId, newOpId, sha256, stableStringify } from './digest';
import type {
  Decision,
  EventKind,
  GelEvent,
  Material,
  MaterialKind,
  MaterialPayload,
  PipelineResult,
  Snapshot,
} from '../shared/types';

// 存储层：不可变材料 + 追加式事件 + 可修改决定 + 派生计算缓存。
// 所有写入经过 ops 日志：pending -> committed；启动时回收未提交的半写。

const JOURNALED_TABLES = ['materials', 'events', 'decisions', 'computations', 'snapshots'] as const;

export class GelStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ops (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        blob BLOB,
        seq INTEGER NOT NULL,
        op_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        parents TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        param_version TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        op_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        band_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        option_mw REAL,
        branch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        op_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS computations (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        op_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        event_id TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        op_id TEXT NOT NULL
      );
    `);
    this.recover();
  }

  // 半写恢复：删除所有仍处 pending 的 op 留下的行
  recover(): number {
    const pending = this.db
      .prepare(`SELECT id FROM ops WHERE status = 'pending'`)
      .all() as { id: string }[];
    if (pending.length === 0) return 0;
    const ids = pending.map((p) => p.id);
    const marks = ids.map(() => '?').join(',');
    for (const table of JOURNALED_TABLES) {
      this.db.prepare(`DELETE FROM ${table} WHERE op_id IN (${marks})`).run(...ids);
    }
    this.db.prepare(`DELETE FROM ops WHERE status = 'pending'`).run();
    return pending.length;
  }

  private withOp<T>(fn: (opId: string) => T): T {
    const opId = newOpId();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`INSERT INTO ops (id, status, created_at) VALUES (?, 'pending', ?)`)
        .run(opId, new Date().toISOString());
      const out = fn(opId);
      this.db.prepare(`UPDATE ops SET status = 'committed' WHERE id = ?`).run(opId);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private nextSeq(table: 'materials' | 'events' | 'decisions'): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM ${table}`).get() as {
      s: number;
    };
    return row.s;
  }

  addMaterial(
    kind: MaterialKind,
    payload: MaterialPayload,
    blob: Buffer | null,
    opId?: string,
  ): Material {
    const digest = sha256(stableStringify(payload));
    const id = contentId(
      { image: 'img', ladder: 'lad', lane: 'lane', 'band-centers': 'band' }[kind],
      { kind, payload, blobSha: blob ? sha256(blob) : null },
    );
    const insert = (op: string) => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO materials (id, kind, payload, digest, blob, seq, op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, kind, JSON.stringify(payload), digest, blob, this.nextSeq('materials'), op);
    };
    if (opId) insert(opId);
    else this.withOp(insert);
    return this.getMaterial(id)!;
  }

  getMaterial(id: string): Material | null {
    const row = this.db.prepare(`SELECT * FROM materials WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToMaterial(row) : null;
  }

  getMaterialBlob(id: string): Buffer | null {
    const row = this.db.prepare(`SELECT blob FROM materials WHERE id = ?`).get(id) as
      | { blob: Buffer | null }
      | undefined;
    return row?.blob ?? null;
  }

  listMaterials(): Material[] {
    const rows = this.db.prepare(`SELECT * FROM materials ORDER BY seq ASC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToMaterial(r));
  }

  private rowToMaterial(row: Record<string, unknown>): Material {
    return {
      id: row.id as string,
      kind: row.kind as MaterialKind,
      payload: JSON.parse(row.payload as string) as MaterialPayload,
      digest: row.digest as string,
      hasBlob: row.blob != null,
      seq: row.seq as number,
    };
  }

  appendEvent(
    kind: EventKind,
    payload: unknown,
    parents: string[],
    inputDigest: string,
    paramVersion: string,
    branch: string,
    opId?: string,
  ): GelEvent {
    const seq = this.nextSeq('events');
    const id = eventId(seq, { kind, payload, parents, inputDigest, paramVersion, branch });
    const insert = (op: string) => {
      this.db
        .prepare(
          `INSERT INTO events (id, seq, kind, parents, input_digest, param_version, branch, payload, created_at, op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          seq,
          kind,
          JSON.stringify(parents),
          inputDigest,
          paramVersion,
          branch,
          JSON.stringify(payload),
          new Date().toISOString(),
          op,
        );
    };
    if (opId) insert(opId);
    else this.withOp(insert);
    return this.getEvent(id)!;
  }

  getEvent(id: string): GelEvent | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  listEvents(): GelEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events ORDER BY seq ASC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToEvent(r));
  }

  private rowToEvent(row: Record<string, unknown>): GelEvent {
    return {
      id: row.id as string,
      seq: row.seq as number,
      kind: row.kind as GelEvent['kind'],
      parents: JSON.parse(row.parents as string) as string[],
      inputDigest: row.input_digest as string,
      paramVersion: row.param_version as string,
      branch: row.branch as string,
      payload: JSON.parse(row.payload as string),
      createdAt: row.created_at as string,
    };
  }

  addDecision(
    eventId_: string,
    laneId: string,
    bandKey: string,
    kind: Decision['kind'],
    optionMw: number | null,
    branch: string,
    opId?: string,
  ): Decision {
    const seq = this.nextSeq('decisions');
    const id = contentId('dec', { eventId_, laneId, bandKey, kind, optionMw, branch, seq });
    const insert = (op: string) => {
      this.db
        .prepare(
          `INSERT INTO decisions (id, event_id, lane_id, band_key, kind, option_mw, branch, seq, op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, eventId_, laneId, bandKey, kind, optionMw, branch, seq, op);
    };
    if (opId) insert(opId);
    else this.withOp(insert);
    return this.listDecisions().find((d) => d.id === id)!;
  }

  listDecisions(upToEventSeq?: number): Decision[] {
    const rows = (
      upToEventSeq == null
        ? this.db.prepare(`SELECT * FROM decisions ORDER BY seq ASC`).all()
        : this.db
            .prepare(
              `SELECT d.* FROM decisions d JOIN events e ON d.event_id = e.id
               WHERE e.seq <= ? ORDER BY d.seq ASC`,
            )
            .all(upToEventSeq)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      eventId: r.event_id as string,
      laneId: r.lane_id as string,
      bandKey: r.band_key as string,
      kind: r.kind as Decision['kind'],
      optionMw: (r.option_mw as number | null) ?? undefined,
      branch: r.branch as string,
      seq: r.seq as number,
    }));
  }

  saveComputation(result: PipelineResult, eventId_: string, opId?: string): void {
    const insert = (op: string) => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO computations (id, event_id, status, result, op_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(result.computationId, eventId_, result.status, JSON.stringify(result), op);
    };
    if (opId) insert(opId);
    else this.withOp(insert);
  }

  getComputation(id: string): PipelineResult | null {
    const row = this.db.prepare(`SELECT result FROM computations WHERE id = ?`).get(id) as
      | { result: string }
      | undefined;
    return row ? (JSON.parse(row.result) as PipelineResult) : null;
  }

  listComputations(): { id: string; eventId: string; status: string }[] {
    return this.db
      .prepare(`SELECT id, event_id AS eventId, status FROM computations ORDER BY rowid ASC`)
      .all() as { id: string; eventId: string; status: string }[];
  }

  saveSnapshot(snapshot: Snapshot, opId?: string): void {
    const insert = (op: string) => {
      this.db
        .prepare(`INSERT OR REPLACE INTO snapshots (event_id, result, op_id) VALUES (?, ?, ?)`)
        .run(snapshot.eventId, JSON.stringify(snapshot), op);
    };
    if (opId) insert(opId);
    else this.withOp(insert);
  }

  getSnapshot(eventId_: string): Snapshot | null {
    const row = this.db.prepare(`SELECT result FROM snapshots WHERE event_id = ?`).get(eventId_) as
      | { result: string }
      | undefined;
    return row ? (JSON.parse(row.result) as Snapshot) : null;
  }

  listSnapshots(): Snapshot[] {
    const rows = this.db.prepare(`SELECT result FROM snapshots ORDER BY rowid ASC`).all() as {
      result: string;
    }[];
    return rows.map((r) => JSON.parse(r.result) as Snapshot);
  }

  isSeeded(): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    return row.n > 0;
  }

  close(): void {
    this.db.close();
  }
}
