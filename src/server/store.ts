import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnalysisResult, ExportBundle, GelEvent, MaterialRecord } from '../shared/types.ts';
import { FormatCorruptError, IncompleteInputError } from '../shared/errors.ts';
import { sha256, stableStringify } from '../domain/identity.ts';

export interface StoredBlob {
  path: string;
  mediaType: string;
  sha256: string;
  data: Buffer;
}

export interface SnapshotState {
  events: GelEvent[];
  materials: MaterialRecord[];
  results: AnalysisResult[];
}

export class GelStore {
  readonly db: DatabaseSync;

  constructor(private readonly databasePath: string, private readonly blobRoot: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    mkdirSync(blobRoot, { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        parent_ids TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        checksum TEXT NOT NULL,
        UNIQUE(branch_id, seq)
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        supersedes_id TEXT,
        scope TEXT,
        checksum TEXT NOT NULL,
        material TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        adopted INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        path TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS import_stages (
        import_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        bundle_sha TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  appendEvent(event: GelEvent): void {
    const parentStmt = this.db.prepare('SELECT id FROM events WHERE id = ?');
    for (const parentId of event.parentIds) {
      if (!parentStmt.get(parentId)) throw new IncompleteInputError(`parent event ${parentId} does not exist`, '$.events[].parentIds');
    }
    const payload = JSON.stringify(event);
    this.db.prepare(`
      INSERT INTO events (id, project_id, branch_id, seq, parent_ids, timestamp, actor, type, payload, checksum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.projectId,
      event.branchId,
      event.seq,
      JSON.stringify(event.parentIds),
      event.timestamp,
      event.actor,
      event.type,
      payload,
      sha256(payload)
    );
  }

  putMaterial(record: MaterialRecord, branchId: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO materials (id, project_id, branch_id, kind, created_at, supersedes_id, scope, checksum, material)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.projectId,
      branchId,
      record.kind,
      record.createdAt,
      record.supersedesId ?? null,
      record.scope ? JSON.stringify(record.scope) : null,
      record.checksum,
      JSON.stringify(record.material)
    );
  }

  putResult(result: AnalysisResult): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO results (id, project_id, branch_id, event_id, adopted, created_at, result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.projectId, result.branchId, result.eventId, result.adopted ? 1 : 0, result.createdAt, JSON.stringify(result));
  }

  setAdopted(resultId: string, adopted: boolean): void {
    this.db.prepare('UPDATE results SET adopted = ? WHERE id = ?').run(adopted ? 1 : 0, resultId);
  }

  putBlob(blob: StoredBlob, projectId: string): void {
    const target = `${this.blobRoot}/${blob.path}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blob.data);
    this.db.prepare('INSERT OR REPLACE INTO blobs (path, project_id, media_type, sha256) VALUES (?, ?, ?, ?)')
      .run(blob.path, projectId, blob.mediaType, blob.sha256);
  }

  getBlob(path: string): StoredBlob | undefined {
    const row = this.db.prepare('SELECT path, media_type, sha256 FROM blobs WHERE path = ?').get(path) as
      | { path: string; media_type: string; sha256: string }
      | undefined;
    if (!row) return undefined;
    return { ...row, data: readFileSync(`${this.blobRoot}/${path}`) };
  }

  allBlobs(): StoredBlob[] {
    const rows = this.db.prepare('SELECT path FROM blobs ORDER BY path').all() as Array<{ path: string }>;
    return rows.map((row) => this.getBlob(row.path)!).filter(Boolean);
  }

  snapshot(projectId: string): SnapshotState {
    const events = (this.db.prepare('SELECT payload FROM events WHERE project_id = ? ORDER BY branch_id, seq')
      .all(projectId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as GelEvent);
    const materials = (this.db.prepare('SELECT material FROM materials WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId) as Array<{ material: string }>).map((row) => JSON.parse(row.material) as MaterialRecord);
    const results = (this.db.prepare('SELECT result FROM results WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId) as Array<{ result: string }>).map((row) => JSON.parse(row.result) as AnalysisResult);
    return { events, materials, results };
  }

  projectExists(projectId: string): boolean {
    return Boolean((this.db.prepare('SELECT 1 FROM events WHERE project_id = ? LIMIT 1').get(projectId)));
  }

  beginImport(importId: string, projectId: string, bundleSha: string, at: string): void {
    this.db.prepare('INSERT OR REPLACE INTO import_stages (import_id, project_id, stage, bundle_sha, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(importId, projectId, 'staged', bundleSha, at);
  }

  finishImport(importId: string): void {
    this.db.prepare('UPDATE import_stages SET stage = ? WHERE import_id = ?').run('committed', importId);
  }

  failImport(importId: string): void {
    this.db.prepare('UPDATE import_stages SET stage = ? WHERE import_id = ?').run('failed', importId);
  }

  pendingImports(): Array<{ importId: string; projectId: string; stage: string; bundleSha: string }> {
    return (this.db.prepare('SELECT import_id, project_id, stage, bundle_sha FROM import_stages WHERE stage = ?').all('staged') as
      Array<{ import_id: string; project_id: string; stage: string; bundle_sha: string }>)
      .map((row) => ({ importId: row.import_id, projectId: row.project_id, stage: row.stage, bundleSha: row.bundle_sha }));
  }

  importBundle(bundle: ExportBundle, mode: 'replace' | 'insert'): void {
    if (!bundle || bundle.schema !== 'gel-ladder-workbench-case-pack') {
      throw new FormatCorruptError('unsupported case pack schema', '$.schema');
    }
    if (!Array.isArray(bundle.project?.branches) || bundle.project.branches.length === 0) {
      throw new IncompleteInputError('case pack contains no branches', '$.project.branches');
    }
    const importId = `import_${sha256(bundle.checksums?.eventsSha256 ?? bundle).slice(0, 16)}`;
    const tx = this.db.transaction((): void => {
      this.beginImport(importId, bundle.project.projectId, bundle.checksums.eventsSha256, bundle.exportedAt);
      if (mode === 'replace') {
        for (const table of ['events', 'materials', 'results', 'blobs', 'import_stages'] as const) {
          this.db.exec(`DELETE FROM ${table}`);
        }
      } else if (this.projectExists(bundle.project.projectId)) {
        throw new FormatCorruptError('project already exists', '$.project.projectId');
      }
      for (const event of bundle.project.branches.flatMap((branch) => branch.events)) {
        if (event.projectId !== bundle.project.projectId) throw new FormatCorruptError('event project mismatch', '$.events[].projectId');
        this.appendEvent(event);
      }
      for (const branch of bundle.project.branches) {
        for (const material of branch.materials) this.putMaterial(material, branch.branchId);
        for (const result of branch.results) this.putResult(result);
      }
      for (const blob of bundle.blobs) {
        const data = Buffer.from(blob.base64, 'base64');
        if (sha256(data) !== blob.sha256) throw new FormatCorruptError(`blob ${blob.path} checksum mismatch`, '$.blobs[].sha256');
        this.putBlob({ path: blob.path, mediaType: blob.mediaType, sha256: blob.sha256, data }, bundle.project.projectId);
      }
      this.finishImport(importId);
    });
    try {
      tx();
    } catch (error) {
      this.failImport(importId);
      throw error;
    }
  }

  exportBundle(projectId: string, exportedAt: string): ExportBundle {
    const snapshot = this.snapshot(projectId);
    const eventsByBranch = new Map<string, GelEvent[]>();
    const materialsByBranch = new Map<string, MaterialRecord[]>();
    const resultsByBranch = new Map<string, AnalysisResult[]>();
    for (const event of snapshot.events) {
      eventsByBranch.set(event.branchId, [...(eventsByBranch.get(event.branchId) ?? []), event]);
    }
    for (const material of snapshot.materials) {
      const branchId = (this.db.prepare('SELECT branch_id FROM materials WHERE id = ?').get(material.id) as { branch_id: string }).branch_id;
      materialsByBranch.set(branchId, [...(materialsByBranch.get(branchId) ?? []), material]);
    }
    for (const result of snapshot.results) {
      resultsByBranch.set(result.branchId, [...(resultsByBranch.get(result.branchId) ?? []), result]);
    }
    const branches = [...new Set(snapshot.events.map((event) => event.branchId))].map((branchId) => {
      const branchEvents = eventsByBranch.get(branchId) ?? [];
      const created = branchEvents.find((event) => event.type === 'branch.created');
      const name = created?.type === 'branch.created' ? created.payload.name : 'main';
      const scenario = created?.type === 'branch.created' ? created.payload.scenario : 'baseline';
      return {
        branchId,
        name,
        scenario,
        events: branchEvents,
        materials: materialsByBranch.get(branchId) ?? [],
        results: resultsByBranch.get(branchId) ?? [],
        headEventIds: branchEvents.filter((event) => !snapshot.events.some((other) => other.parentIds.includes(event.id))).map((event) => event.id)
      };
    });
    return {
      schema: 'gel-ladder-workbench-case-pack',
      schemaVersion: '1.0.0',
      exportedAt,
      project: { projectId, name: '胶道标尺离线案例', branches },
      blobs: this.allBlobs().map((blob) => ({ path: blob.path, mediaType: blob.mediaType, sha256: blob.sha256, base64: blob.data.toString('base64') })),
      checksums: {
        eventsSha256: sha256(branches.flatMap((branch) => branch.events).map(stableStringify)),
        materialsSha256: sha256(branches.flatMap((branch) => branch.materials).map(stableStringify))
      }
    };
  }
}
