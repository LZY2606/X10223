import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digestOf, sha256Hex, stableId } from '../shared/hash.js';
import { Diagnostic, Outcome, corrupt, ok } from '../shared/result.js';

/**
 * Persistence layer. Two tiers:
 *  - materials: IMMUTABLE evidence (image, orientation, exposure, ladder
 *    nominals, lane boundaries, band centers) with pixel-level sources.
 *  - events/derived: the mutable decision layer, append-only; invalidation is
 *    itself an event, so any historical state can be restored as-of a seq.
 */

export interface MaterialRow {
  id: string;
  kind: string;
  branch: string;
  payload: string; // canonical json
  digest: string;
  blob: Buffer | null;
  seq: number;
  created_by_event: string | null;
  supersedes: string | null;
}

export interface EventRow {
  id: string;
  seq: number;
  branch: string;
  parents: string; // json array of event ids
  type: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  payload: string;
  created_at: string;
}

export interface DerivedRow {
  id: string;
  kind: string;
  subject: string;
  branch: string;
  input_digest: string;
  param_version: string;
  parents: string; // json array of material ids
  payload: string;
  seq: number;
}

export const BUNDLE_FORMAT = 'gel-case-bundle';
export const BUNDLE_VERSION = 1;

export class CaseStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS materials(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        branch TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        blob BLOB,
        seq INTEGER NOT NULL,
        created_by_event TEXT,
        supersedes TEXT
      );
      CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        branch TEXT NOT NULL,
        parents TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS derived(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        branch TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        param_version TEXT NOT NULL,
        parents TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches(
        name TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private nextSeq(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(s),0)+1 AS n FROM (
           SELECT seq AS s FROM events UNION ALL SELECT seq FROM materials UNION ALL SELECT seq FROM derived)`,
      )
      .get() as { n: number };
    return row.n;
  }

  ensureBranch(name: string, createdBy: string | null = null): void {
    this.db
      .prepare('INSERT OR IGNORE INTO branches(name, seq, created_by) VALUES (?,?,?)')
      .run(name, this.nextSeq(), createdBy);
  }

  branches(): { name: string; seq: number; created_by: string | null }[] {
    return this.db.prepare('SELECT * FROM branches ORDER BY seq').all() as never;
  }

  /** Add immutable material. Deterministic id -> idempotent across export/import. */
  addMaterial(
    kind: string,
    branch: string,
    payload: unknown,
    opts: { blob?: Buffer; createdByEvent?: string; supersedes?: string } = {},
  ): MaterialRow {
    const canonical = canonicalJson(payload);
    const digest = sha256Hex(canonical);
    const id = stableId('mat', kind, branch, digest);
    const existing = this.db.prepare('SELECT id FROM materials WHERE id=?').get(id);
    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO materials(id,kind,branch,payload,digest,blob,seq,created_by_event,supersedes) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          kind,
          branch,
          canonical,
          digest,
          opts.blob ?? null,
          this.nextSeq(),
          opts.createdByEvent ?? null,
          opts.supersedes ?? null,
        );
    }
    return this.getMaterial(id)!;
  }

  getMaterial(id: string): MaterialRow | undefined {
    return this.db.prepare('SELECT * FROM materials WHERE id=?').get(id) as MaterialRow | undefined;
  }

  /** Current (non-superseded) materials of a branch, optionally as-of a seq. */
  currentMaterials(branch: string, asOfSeq?: number): MaterialRow[] {
    const limit = asOfSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare(
        `SELECT * FROM materials m
         WHERE m.branch=? AND m.seq<=?
           AND NOT EXISTS (
             SELECT 1 FROM materials n WHERE n.supersedes=m.id AND n.branch=m.branch AND n.seq<=?)
         ORDER BY m.seq`,
      )
      .all(branch, limit, limit) as MaterialRow[];
  }

  appendEvent(
    type: string,
    branch: string,
    payload: unknown,
    opts: { parents?: string[]; status?: EventRow['status']; id?: string } = {},
  ): EventRow {
    const canonical = canonicalJson(payload);
    const id = opts.id ?? stableId('evt', type, branch, canonical);
    const existing = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as EventRow | undefined;
    if (existing) return existing;
    this.db
      .prepare('INSERT INTO events(id,seq,branch,parents,type,status,payload,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(
        id,
        this.nextSeq(),
        branch,
        canonicalJson(opts.parents ?? []),
        type,
        opts.status ?? 'accepted',
        canonical,
        new Date().toISOString(),
      );
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as EventRow;
  }

  events(branch?: string, asOfSeq?: number): EventRow[] {
    const limit = asOfSeq ?? Number.MAX_SAFE_INTEGER;
    if (branch) {
      return this.db
        .prepare('SELECT * FROM events WHERE branch=? AND seq<=? ORDER BY seq, id')
        .all(branch, limit) as EventRow[];
    }
    return this.db.prepare('SELECT * FROM events WHERE seq<=? ORDER BY seq, id').all(limit) as EventRow[];
  }

  putDerived(row: Omit<DerivedRow, 'seq'>): DerivedRow {
    const existing = this.db.prepare('SELECT id FROM derived WHERE id=?').get(row.id);
    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO derived(id,kind,subject,branch,input_digest,param_version,parents,payload,seq) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(row.id, row.kind, row.subject, row.branch, row.input_digest, row.param_version, row.parents, row.payload, this.nextSeq());
    }
    return this.db.prepare('SELECT * FROM derived WHERE id=?').get(row.id) as DerivedRow;
  }

  /** Derived rows visible on a branch as-of a seq (invalidation is an event, so history is restorable). */
  derivedVisible(branch: string, asOfSeq?: number): DerivedRow[] {
    const limit = asOfSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare(
        `SELECT * FROM derived d
         WHERE d.branch=? AND d.seq<=?
           AND NOT EXISTS (
             SELECT 1 FROM events e
             WHERE e.type='invalidation' AND e.seq<=?
               AND EXISTS (SELECT 1 FROM json_each(e.payload) WHERE json_extract(value,'$.derivedId')=d.id))
         ORDER BY d.seq`,
      )
      .all(branch, limit, limit) as DerivedRow[];
  }

  /** Invalidation is recorded as an event; derived rows themselves are never mutated. */
  invalidateDerived(derivedIds: string[], branch: string, reason: string, parents: string[] = []): EventRow {
    return this.appendEvent(
      'invalidation',
      branch,
      derivedIds.map((derivedId) => ({ derivedId, reason })),
      { parents },
    );
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  counts(): { materials: number; events: number; derived: number; branches: number } {
    const c = (t: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { materials: c('materials'), events: c('events'), derived: c('derived'), branches: c('branches') };
  }

  // ---------- export / import ----------

  exportBundle(): string {
    const body = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      meta: this.db.prepare('SELECT key,value FROM meta ORDER BY key').all(),
      branches: this.db.prepare('SELECT * FROM branches ORDER BY seq').all(),
      materials: (this.db.prepare('SELECT * FROM materials ORDER BY seq').all() as MaterialRow[]).map((m) => ({
        ...m,
        blob: m.blob ? Buffer.from(m.blob).toString('base64') : null,
      })),
      events: this.db.prepare('SELECT * FROM events ORDER BY seq, id').all(),
      derived: this.db.prepare('SELECT * FROM derived ORDER BY seq').all(),
    };
    const checksum = sha256Hex(canonicalJson(body));
    return JSON.stringify({ ...body, checksum }, null, 2);
  }

  /**
   * Import a bundle. Corrupt format (bad json / bad envelope / bad checksum)
   * is a distinct outcome. All inserts run in ONE transaction: a failure
   * mid-way rolls back, so a half-written import can never persist.
   */
  importBundle(text: string): Outcome<{ imported: Record<string, number>; diagnostics: Diagnostic[] }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return corrupt({ code: 'BUNDLE_NOT_JSON', message: `bundle is not valid JSON: ${(e as Error).message}`, at: { path: '$' } });
    }
    const b = parsed as Record<string, unknown>;
    if (b.format !== BUNDLE_FORMAT || typeof b.version !== 'number' || b.version > BUNDLE_VERSION) {
      return corrupt({ code: 'BUNDLE_BAD_ENVELOPE', message: 'unsupported bundle format or version', at: { path: '$.format' } });
    }
    const { checksum, ...body } = b;
    if (typeof checksum !== 'string' || sha256Hex(canonicalJson(body)) !== checksum) {
      return corrupt({ code: 'BUNDLE_CHECKSUM_MISMATCH', message: 'bundle checksum mismatch; file may be truncated or modified', at: { path: '$.checksum' } });
    }
    const diagnostics: Diagnostic[] = [];
    const imported: Record<string, number> = { materials: 0, events: 0, derived: 0, branches: 0 };
    const insertMaterial = this.db.prepare(
      'INSERT OR IGNORE INTO materials(id,kind,branch,payload,digest,blob,seq,created_by_event,supersedes) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO events(id,seq,branch,parents,type,status,payload,created_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    const insertDerived = this.db.prepare(
      'INSERT OR IGNORE INTO derived(id,kind,subject,branch,input_digest,param_version,parents,payload,seq) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const insertBranch = this.db.prepare('INSERT OR IGNORE INTO branches(name,seq,created_by) VALUES (?,?,?)');
    const insertMeta = this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)');

    this.db.exec('BEGIN');
    try {
      for (const br of b.branches as { name: string; seq: number; created_by: string | null }[]) {
        imported.branches += insertBranch.run(br.name, br.seq, br.created_by).changes;
      }
      for (const m of b.materials as (Omit<MaterialRow, 'blob'> & { blob: string | null })[]) {
        const digest = sha256Hex(m.payload);
        if (digest !== m.digest) {
          diagnostics.push({ code: 'MATERIAL_DIGEST_MISMATCH', message: `material ${m.id} payload digest mismatch; skipped`, at: { materialId: m.id } });
          continue;
        }
        imported.materials += insertMaterial.run(
          m.id, m.kind, m.branch, m.payload, m.digest,
          m.blob ? Buffer.from(m.blob, 'base64') : null,
          m.seq, m.created_by_event, m.supersedes,
        ).changes;
      }
      for (const e of b.events as EventRow[]) {
        imported.events += insertEvent.run(e.id, e.seq, e.branch, e.parents, e.type, e.status, e.payload, e.created_at).changes;
      }
      for (const d of b.derived as DerivedRow[]) {
        imported.derived += insertDerived.run(d.id, d.kind, d.subject, d.branch, d.input_digest, d.param_version, d.parents, d.payload, d.seq).changes;
      }
      for (const kv of b.meta as { key: string; value: string }[]) {
        insertMeta.run(kv.key, kv.value);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      return corrupt({ code: 'BUNDLE_IMPORT_ABORTED', message: `import aborted and rolled back: ${(err as Error).message}` });
    }
    return ok({ imported, diagnostics }, diagnostics);
  }

  close(): void {
    this.db.close();
  }
}
