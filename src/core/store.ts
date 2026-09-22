import type { DB } from './db';
import type {
  GelEvent,
  GelEventPayloadMap,
  Material,
  ParamSet,
  Quantity,
} from '../shared/types';
import { makeEvent } from './identity';
import { foldBranch, foldBranchWithParent, type TipState } from './fold';

export interface BranchRow {
  name: string;
  parent_branch: string | null;
  parent_event_id: string | null;
  created_clock: number;
}

/** 时钟：优先显式传入（案例包可确定性重放），否则取分支最大值+1 */
export class ProjectStore {
  constructor(
    private db: DB,
    readonly projectId: string
  ) {}

  static create(db: DB, projectId: string, name: string, opts?: { wallTimeUtcIso?: string; casePackVersion?: string; logicalClock?: number }): ProjectStore {
    const existing = db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(projectId);
    if (existing) throw new Error(`project ${projectId} already exists`);
    const wall = opts?.wallTimeUtcIso ?? new Date().toISOString();
    const clock = opts?.logicalClock ?? 1;
    db.prepare('INSERT INTO projects(project_id, name, created_at_utc, case_pack_version) VALUES(?,?,?,?)').run(
      projectId,
      name,
      wall,
      opts?.casePackVersion ?? null
    );
    db.prepare('INSERT INTO branches(project_id, name, parent_branch, parent_event_id, created_clock) VALUES(?,?,?,?,?)').run(
      projectId,
      'main',
      null,
      null,
      clock
    );
    const store = new ProjectStore(db, projectId);
    store.append('main', 'projectCreated', { name, casePackVersion: opts?.casePackVersion }, { wallTimeUtcIso: wall, logicalClock: clock });
    return store;
  }

  private nextGlobalSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE project_id = ?').get(this.projectId) as { s: number };
    return row.s + 1;
  }

  private nextBranchSeq(branch: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(branch_seq),0) AS s FROM events WHERE project_id = ? AND branch = ?')
      .get(this.projectId, branch) as { s: number };
    return row.s + 1;
  }

  private tipEventId(branch: string): string | null {
    const row = this.db
      .prepare('SELECT event_id FROM events WHERE project_id = ? AND branch = ? ORDER BY branch_seq DESC LIMIT 1')
      .get(this.projectId, branch) as { event_id?: string };
    return row?.event_id ?? null;
  }

  maxClock(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(logical_clock),0) AS c FROM events WHERE project_id = ?').get(this.projectId) as { c: number };
    return row.c;
  }

  append<T extends GelEvent['type']>(
    branch: string,
    type: T,
    payload: GelEventPayloadMap[T],
    opts?: { wallTimeUtcIso?: string; logicalClock?: number }
  ): GelEvent {
    const branchSeq = this.nextBranchSeq(branch);
    const prevEventId = this.tipEventId(branch);
    const logicalClock = opts?.logicalClock ?? this.maxClock() + 1;
    const wallTimeUtcIso = opts?.wallTimeUtcIso ?? new Date().toISOString();
    const event = makeEvent({
      seq: this.nextGlobalSeq(),
      branch,
      branchSeq,
      prevEventId,
      type,
      payload,
      logicalClock,
      wallTimeUtcIso,
    });
    this.db
      .prepare(
        `INSERT INTO events(event_id, project_id, seq, branch, branch_seq, prev_event_id, type, payload_json, logical_clock, wall_time_utc, digest)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        event.eventId,
        this.projectId,
        event.seq,
        event.branch,
        event.branchSeq,
        event.prevEventId,
        event.type,
        JSON.stringify(event.payload),
        event.logicalClock,
        event.wallTimeUtcIso,
        event.digest
      );
    return event;
  }

  addMaterial(branch: string, material: Material, opts?: { wallTimeUtcIso?: string; logicalClock?: number; supersede?: { subjectId: string; reason: string } }): GelEvent {
    if (opts?.supersede) {
      return this.append(
        branch,
        'materialSuperseded',
        {
          materialKind: material.kind,
          subjectId: opts.supersede.subjectId,
          newMaterial: material,
          reason: opts.supersede.reason,
        },
        opts
      );
    }
    return this.append(branch, 'materialAdded', { material }, opts);
  }

  recordDecision(
    branch: string,
    decision: GelEventPayloadMap['decisionRecorded']['decision'],
    subjectId: string,
    extras: { note?: string; paramSet?: ParamSet; value?: Quantity; payload?: Record<string, unknown>; logicalClock?: number; wallTimeUtcIso?: string } = {}
  ): GelEvent {
    return this.append(
      branch,
      'decisionRecorded',
      { decision, subjectId, note: extras.note, paramSet: extras.paramSet, value: extras.value, payload: extras.payload },
      { logicalClock: extras.logicalClock, wallTimeUtcIso: extras.wallTimeUtcIso }
    );
  }

  createBranch(name: string, parentBranch: string, opts?: { wallTimeUtcIso?: string; logicalClock?: number }): GelEvent {
    if (this.getBranch(name)) throw new Error(`branch ${name} already exists`);
    const parentEventId = this.tipEventId(parentBranch);
    const clock = opts?.logicalClock ?? this.maxClock() + 1;
    this.db
      .prepare('INSERT INTO branches(project_id, name, parent_branch, parent_event_id, created_clock) VALUES(?,?,?,?,?)')
      .run(this.projectId, name, parentBranch, parentEventId, clock);
    return this.append(
      name,
      'branchCreated',
      { name, parentBranch, parentEventId: parentEventId! },
      { wallTimeUtcIso: opts?.wallTimeUtcIso, logicalClock: clock }
    );
  }

  getBranch(name: string): BranchRow | undefined {
    return this.db
      .prepare('SELECT name, parent_branch, parent_event_id, created_clock FROM branches WHERE project_id = ? AND name = ?')
      .get(this.projectId, name) as BranchRow | undefined;
  }

  listBranches(): BranchRow[] {
    return this.db
      .prepare('SELECT name, parent_branch, parent_event_id, created_clock FROM branches WHERE project_id = ? ORDER BY created_clock')
      .all(this.projectId) as unknown as BranchRow[];
  }

  events(branch?: string): GelEvent[] {
    const rows = branch
      ? (this.db
          .prepare('SELECT payload_json, event_id, seq, branch, branch_seq, prev_event_id, type, logical_clock, wall_time_utc, digest FROM events WHERE project_id = ? AND branch = ? ORDER BY branch_seq')
          .all(this.projectId, branch) as any[])
      : (this.db
          .prepare('SELECT payload_json, event_id, seq, branch, branch_seq, prev_event_id, type, logical_clock, wall_time_utc, digest FROM events WHERE project_id = ? ORDER BY seq')
          .all(this.projectId) as any[]);
    return rows.map((r) => ({
      eventId: r.event_id,
      seq: r.seq,
      branch: r.branch,
      branchSeq: r.branch_seq,
      prevEventId: r.prev_event_id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      logicalClock: r.logical_clock,
      wallTimeUtcIso: r.wall_time_utc,
      digest: r.digest,
    }));
  }

  putBlob(uri: string, sha256: string, mediaType: string, bytes: Buffer) {
    this.db
      .prepare('INSERT OR REPLACE INTO blobs(project_id, uri, sha256, media_type, bytes) VALUES(?,?,?,?,?)')
      .run(this.projectId, uri, sha256, mediaType, bytes);
  }

  getBlob(uri: string): { sha256: string; mediaType: string; bytes: Buffer } | undefined {
    const row = this.db.prepare('SELECT sha256, media_type, bytes FROM blobs WHERE project_id = ? AND uri = ?').get(this.projectId, uri) as
      | { sha256: string; media_type: string; bytes: Buffer }
      | undefined;
    return row;
  }

  listBlobs(): { uri: string; sha256: string; media_type: string }[] {
    return this.db
      .prepare('SELECT uri, sha256, media_type FROM blobs WHERE project_id = ?')
      .all(this.projectId) as unknown as { uri: string; sha256: string; media_type: string }[];
  }

  tip(branch: string, upToBranchSeq?: number): TipState {
    const row = this.getBranch(branch);
    const all = this.events();
    if (!row || !row.parent_branch) return foldBranch(all.filter((e) => e.branch === branch), upToBranchSeq);
    return foldBranchWithParent({
      projectEvents: all,
      branch,
      parentBranch: row.parent_branch,
      forkPointEventId: row.parent_event_id,
      upToBranchSeq,
    });
  }
}

export function listProjects(db: DB): { projectId: string; name: string; casePackVersion: string | null }[] {
  return db
    .prepare('SELECT project_id AS projectId, name, case_pack_version AS casePackVersion FROM projects ORDER BY created_at_utc')
    .all() as any;
}
