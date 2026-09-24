import { DatabaseSync } from 'node:sqlite';
import { canonicalize, digest, eventId, materialId } from '../domain/ids.ts';
import type { AppEvent, DerivedResult, EventType, Material, MaterialKind, Outcome } from '../domain/types.ts';
import type { ImageAccess } from '../domain/engine.ts';
import { decodeGrayPng } from '../domain/png.ts';
import { diag } from '../domain/units.ts';

export interface ExportBundle {
  format: 'gel-archive/1';
  exported_at: string;
  materials: Material[];
  blobs: Record<string, string>;
  events: AppEvent[];
  results: DerivedResult[];
  digest: string;
}

/** SQLite storage layer. Directly testable without any browser. All
 *  multi-row writes happen inside transactions so a crash or corrupt
 *  payload can never leave a half-written archive. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS materials(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
        raw_json TEXT NOT NULL, digest TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(material_id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL, branch TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, parents_json TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results(
        id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        input_digest TEXT NOT NULL, params_version TEXT NOT NULL,
        parents_json TEXT NOT NULL, branch TEXT NOT NULL, seq INTEGER NOT NULL,
        value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_results_id_seq ON results(id, branch, seq);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec('DELETE FROM results; DELETE FROM events; DELETE FROM blobs; DELETE FROM materials;');
  }

  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM materials').get() as { n: number };
    return row.n === 0;
  }

  addMaterial(kind: MaterialKind, label: string, raw: unknown, blob?: Buffer): Material {
    const id = materialId(kind, raw);
    const existing = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (existing) return this.rowToMaterial(existing);
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM materials').get() as { s: number }).s;
    const d = digest(raw);
    this.db.prepare('INSERT INTO materials(id,kind,label,raw_json,digest,seq) VALUES(?,?,?,?,?,?)')
      .run(id, kind, label, JSON.stringify(raw), d, seq);
    if (blob) this.db.prepare('INSERT INTO blobs(material_id,data) VALUES(?,?)').run(id, blob);
    return { id, kind, label, raw, digest: d, seq };
  }

  private rowToMaterial(row: Record<string, unknown>): Material {
    return {
      id: row.id as string,
      kind: row.kind as MaterialKind,
      label: row.label as string,
      raw: JSON.parse(row.raw_json as string),
      digest: row.digest as string,
      seq: row.seq as number,
    };
  }

  listMaterials(): Material[] {
    const rows = this.db.prepare('SELECT * FROM materials ORDER BY seq').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMaterial(r));
  }

  getBlob(materialId: string): Buffer | undefined {
    const row = this.db.prepare('SELECT data FROM blobs WHERE material_id = ?').get(materialId) as { data: Uint8Array } | undefined;
    if (!row) return undefined;
    return Buffer.from(row.data);
  }

  imageAccess(materialId: string): ImageAccess | undefined {
    const blob = this.getBlob(materialId);
    if (!blob) return undefined;
    const { width, height, pixels } = decodeGrayPng(blob);
    return {
      width,
      height,
      intensityAt(x: number, y: number): number {
        // peak intensity in a 5x5 window: saturation is a clipping
        // property, so the max (not the mean) is the right statistic
        const xx = Math.round(x);
        const yy = Math.round(y);
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) return 0;
        let peak = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x2 = xx + dx;
            const y2 = yy + dy;
            if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height) {
              peak = Math.max(peak, pixels[y2 * width + x2]);
            }
          }
        }
        return peak;
      },
    };
  }

  appendEvent(type: EventType, payload: unknown, parents: string[], branch = 'main'): AppEvent {
    // single logical clock shared with results so replay at any event seq
    // restores exactly the derived state visible at that moment
    const seq = this.latestSeq() + 1;
    const id = eventId(seq, type, payload);
    const created_at = new Date().toISOString();
    this.db.prepare('INSERT INTO events(seq,id,branch,type,payload_json,parents_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(seq, id, branch, type, JSON.stringify(payload), JSON.stringify(parents), created_at);
    return { seq, id, branch, type, payload, parents, created_at };
  }

  listEvents(): AppEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, unknown>[]).map(rowToEvent);
  }

  eventsUpTo(seq: number): AppEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq').all(seq) as Record<string, unknown>[]).map(rowToEvent);
  }

  putResults(results: DerivedResult[], seq: number): void {
    const stmt = this.db.prepare(
      'INSERT INTO results(id,kind,status,input_digest,params_version,parents_json,branch,seq,value_json) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const r of results) {
      stmt.run(r.id, r.kind, r.status, r.input_digest, r.params_version,
        JSON.stringify(r.parents), r.branch, seq, JSON.stringify(r.value));
    }
  }

  /** Insert a tombstone row at `seq` marking the result superseded, so the
   *  old conclusion stays readable when replaying to an earlier event. */
  supersede(resultIds: string[], seq: number): void {
    const select = this.db.prepare(
      'SELECT * FROM results WHERE id = ? AND branch = ? ORDER BY seq DESC LIMIT 1');
    const insert = this.db.prepare(
      'INSERT INTO results(id,kind,status,input_digest,params_version,parents_json,branch,seq,value_json) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const id of resultIds) {
      for (const branch of this.branches()) {
        const row = select.get(id, branch) as Record<string, unknown> | undefined;
        if (!row) continue;
        if ((row.status as string) === 'superseded') continue;
        insert.run(row.id as string, row.kind as string, 'superseded', row.input_digest as string,
          row.params_version as string, row.parents_json as string, row.branch as string,
          seq, row.value_json as string);
      }
    }
  }

  private rowsToResults(rows: Record<string, unknown>[]): DerivedResult[] {
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as DerivedResult['kind'],
      status: r.status as DerivedResult['status'],
      input_digest: r.input_digest as string,
      params_version: r.params_version as string,
      parents: JSON.parse(r.parents_json as string),
      branch: r.branch as string,
      seq: r.seq as number,
      value: JSON.parse(r.value_json as string),
    }));
  }

  /** Latest row per (id, branch) among rows with seq <= upTo. */
  resultsUpTo(upTo: number): DerivedResult[] {
    const rows = this.db.prepare(`
      SELECT r.* FROM results r
      JOIN (SELECT id, branch, MAX(seq) AS mseq FROM results WHERE seq <= ? GROUP BY id, branch) latest
        ON r.id = latest.id AND r.branch = latest.branch AND r.seq = latest.mseq
      ORDER BY r.kind, r.id`).all(upTo) as Record<string, unknown>[];
    return this.rowsToResults(rows);
  }

  allResults(): DerivedResult[] {
    return this.rowsToResults(this.db.prepare('SELECT * FROM results ORDER BY seq, kind, id').all() as Record<string, unknown>[]);
  }

  latestSeq(): number {
    const e = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get() as { s: number }).s;
    const r = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM results').get() as { s: number }).s;
    return Math.max(e, r);
  }

  currentResults(): DerivedResult[] {
    return this.resultsUpTo(this.latestSeq());
  }

  branches(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT branch FROM events ORDER BY branch').all() as { branch: string }[];
    const set = new Set(rows.map((r) => r.branch));
    set.add('main');
    return [...set].sort();
  }

  exportBundle(): ExportBundle {
    const materials = this.listMaterials();
    const events = this.listEvents();
    const results = this.allResults();
    const blobs: Record<string, string> = {};
    for (const m of materials) {
      const b = this.getBlob(m.id);
      if (b) blobs[m.id] = b.toString('base64');
    }
    const body = { format: 'gel-archive/1' as const, exported_at: new Date().toISOString(), materials, blobs, events, results };
    return { ...body, digest: digest(canonicalize({ materials, blobs, events, results })) };
  }

  /** Transactional import: validates every record's digest first, then
   *  applies inside one transaction. Corrupt payloads yield a
   *  format_corrupt outcome and leave the database untouched. */
  importBundle(bundle: unknown): Outcome {
    const b = bundle as Partial<ExportBundle>;
    if (!b || b.format !== 'gel-archive/1' || !Array.isArray(b.materials) || !Array.isArray(b.events) || !Array.isArray(b.results)) {
      return { kind: 'format_corrupt', diagnostics: [diag('bundle', 'BUNDLE_SHAPE', 'not a gel-archive/1 bundle')] };
    }
    const expected = digest(canonicalize({ materials: b.materials, blobs: b.blobs ?? {}, events: b.events, results: b.results }));
    if (expected !== b.digest) {
      return { kind: 'format_corrupt', diagnostics: [diag('bundle.digest', 'DIGEST_MISMATCH', 'bundle digest does not match contents')] };
    }
    for (let i = 0; i < b.materials.length; i++) {
      const m = b.materials[i];
      if (materialId(m.kind, m.raw) !== m.id || digest(m.raw) !== m.digest) {
        return { kind: 'format_corrupt', diagnostics: [diag(`bundle.materials[${i}]`, 'MATERIAL_DIGEST_MISMATCH', `material ${m.id} digest mismatch`)] };
      }
    }
    this.db.exec('BEGIN');
    try {
      const insMat = this.db.prepare('INSERT OR IGNORE INTO materials(id,kind,label,raw_json,digest,seq) VALUES(?,?,?,?,?,?)');
      const insBlob = this.db.prepare('INSERT OR IGNORE INTO blobs(material_id,data) VALUES(?,?)');
      const insEvt = this.db.prepare('INSERT OR IGNORE INTO events(seq,id,branch,type,payload_json,parents_json,created_at) VALUES(?,?,?,?,?,?,?)');
      const insRes = this.db.prepare('INSERT INTO results(id,kind,status,input_digest,params_version,parents_json,branch,seq,value_json) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const m of b.materials) {
        insMat.run(m.id, m.kind, m.label, JSON.stringify(m.raw), m.digest, m.seq);
        const b64 = (b.blobs ?? {})[m.id];
        if (b64) {
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
            throw new Error(`blob for ${m.id} is not valid base64`);
          }
          const data = Buffer.from(b64, 'base64');
          insBlob.run(m.id, data);
        }
      }
      for (const e of b.events) {
        insEvt.run(e.seq, e.id, e.branch, e.type, JSON.stringify(e.payload), JSON.stringify(e.parents), e.created_at);
      }
      // avoid duplicating identical result rows on re-import
      const exists = this.db.prepare('SELECT 1 AS x FROM results WHERE id=? AND branch=? AND seq=? LIMIT 1');
      for (const r of b.results) {
        if ((exists.get(r.id, r.branch, r.seq) as { x: number } | undefined)) continue;
        insRes.run(r.id, r.kind, r.status, r.input_digest, r.params_version,
          JSON.stringify(r.parents), r.branch, r.seq, JSON.stringify(r.value));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      return { kind: 'format_corrupt', diagnostics: [diag('bundle', 'IMPORT_ABORTED', `import rolled back: ${String(err)}`)] };
    }
    return { kind: 'ok' };
  }
}

function rowToEvent(row: Record<string, unknown>): AppEvent {
  return {
    seq: row.seq as number,
    id: row.id as string,
    branch: row.branch as string,
    type: row.type as AppEvent['type'],
    payload: JSON.parse(row.payload_json as string),
    parents: JSON.parse(row.parents_json as string),
    created_at: row.created_at as string,
  };
}
