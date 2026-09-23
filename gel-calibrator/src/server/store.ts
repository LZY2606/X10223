// Repository over SQLite + the event-sourced engine.
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DB } from './db.js';
import { Command, prepareCommand, reduceEvents } from '../core/project.js';
import { GelEvent, Material, ProjectState } from '../core/types.js';
import { ExportEnvelope, buildEnvelope, validateEnvelope } from '../core/archive.js';
import { corrupt, DomainError } from '../core/types.js';

interface ProjectRow { project_id: string; name: string; created_at: string; case_kind: string }
interface EventRow { project_id: string; branch: string; seq: number; event_id: string; type: string; parents_json: string; payload_json: string; hash: string }
interface BranchRow { project_id: string; branch: string; parent_branch: string | null; fork_event: string | null }

export class Store {
  constructor(private db: DB) {}

  listProjects(): ProjectRow[] {
    return this.db.prepare(`SELECT * FROM projects ORDER BY created_at, project_id`).all() as ProjectRow[];
  }
  getProject(pid: string): ProjectRow | undefined {
    return this.db.prepare(`SELECT * FROM projects WHERE project_id = ?`).get(pid) as ProjectRow | undefined;
  }
  createProject(name: string, caseKind = ''): string {
    const pid = `prj_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO projects(project_id,name,created_at,case_kind) VALUES(?,?,?,?)`)
      .run(pid, name, now, caseKind);
    this.db.prepare(`INSERT INTO branches(project_id,branch,parent_branch,fork_event) VALUES(?,?,NULL,NULL)`)
      .run(pid, 'main');
    return pid;
  }
  createProjectWithId(pid: string, name: string, createdAt: string, caseKind: string) {
    this.db.prepare(`INSERT INTO projects(project_id,name,created_at,case_kind) VALUES(?,?,?,?)`)
      .run(pid, name, createdAt, caseKind);
  }

  listBranches(pid: string): BranchRow[] {
    return this.db.prepare(`SELECT * FROM branches WHERE project_id = ? ORDER BY branch`).all(pid) as BranchRow[];
  }
  upsertBranch(pid: string, branch: string, parent: string | null, forkEvent: string | null) {
    this.db.prepare(
      `INSERT INTO branches(project_id,branch,parent_branch,fork_event) VALUES(?,?,?,?)
       ON CONFLICT(project_id,branch) DO UPDATE SET parent_branch=excluded.parent_branch, fork_event=excluded.fork_event`,
    ).run(pid, branch, parent, forkEvent);
  }

  /**
   * Events visible on a branch, in replay order: the ancestor fork chain
   * (truncated at each fork edge's fork_event) followed by this branch's own
   * events. seq is per-branch, so chains are concatenated rather than sorted by
   * a global sequence number.
   */
  branchEvents(pid: string, branch: string): GelEvent[] {
    const chain: Array<{ events: GelEvent[]; upto: string | null }> = [];
    let cur: string | null = branch;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const b = this.db.prepare(`SELECT * FROM branches WHERE project_id=? AND branch=?`)
        .get(pid, cur) as BranchRow | undefined;
      const rows = this.db.prepare(
        `SELECT * FROM events WHERE project_id=? AND branch=? ORDER BY seq`,
      ).all(pid, cur) as EventRow[];
      chain.push({ events: rows.map(rowToEvent), upto: b?.fork_event ?? null });
      cur = b?.parent_branch ?? null;
    }
    // chain is [target, parent, root]; reverse => root ... target.
    chain.reverse();
    const out: GelEvent[] = [];
    for (let i = 0; i < chain.length; i++) {
      const seg = chain[i]!;
      let evs = seg.events;
      // A non-target segment is an ancestor: cap it at the edge at which the
      // NEXT (child) segment forked. The child edge is stored on the child.
      if (i < chain.length - 1) {
        const child = chain[i + 1]!;
        if (child.upto) {
          const idx = evs.findIndex((e) => e.id === child.upto);
          if (idx >= 0) evs = evs.slice(0, idx + 1);
        }
      }
      out.push(...evs); // target branch keeps ALL of its own events
    }
    return out;
  }

  allEvents(pid: string): GelEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE project_id=? ORDER BY branch,seq`).all(pid) as EventRow[];
    return rows.map(rowToEvent);
  }

  stateAt(pid: string, branch: string, uptoEvent?: string): ProjectState {
    let events = this.branchEvents(pid, branch);
    if (uptoEvent) {
      const idx = events.findIndex((e) => e.id === uptoEvent);
      if (idx < 0) throw corrupt(`event[${uptoEvent}]`, 'event not present on this branch lineage');
      events = events.slice(0, idx + 1);
    }
    return reduceEvents(pid, events);
  }

  nextSeq(pid: string, branch: string): number {
    const r = this.db.prepare(
      `SELECT COALESCE(MAX(seq),-1)+1 AS n FROM events WHERE project_id=? AND branch=?`,
    ).get(pid, branch) as { n: number };
    return r.n;
  }

  /** Append one command to a branch. Forks create the branch first. */
  apply(pid: string, branch: string, cmd: Command): { event: GelEvent; error?: DomainError } {
    if (cmd.kind === 'fork') {
      // fork event is recorded ON THE PARENT branch so the edge is in history.
      this.requireBranch(pid, branch);
      const state = this.stateAt(pid, branch, cmd.fromEvent);
      const seq = this.nextSeq(pid, branch);
      const prepared = prepareCommand(pid, branch, seq, state, cmd);
      this.insertEvent(pid, prepared.event);
      const forkEvent = prepared.event.id;
      const fromEvent = cmd.fromEvent ?? state.headEvent ?? null;
      this.upsertBranch(pid, cmd.newBranch, branch, fromEvent ?? forkEvent);
      return { event: prepared.event, error: prepared.error };
    }
    this.requireBranch(pid, branch);
    const state = this.stateAt(pid, branch);
    const seq = this.nextSeq(pid, branch);
    const prepared = prepareCommand(pid, branch, seq, state, cmd);
    this.insertEvent(pid, prepared.event);
    return { event: prepared.event, error: prepared.error };
  }

  private requireBranch(pid: string, branch: string) {
    const b = this.db.prepare(`SELECT 1 FROM branches WHERE project_id=? AND branch=?`).get(pid, branch);
    if (!b) throw corrupt(`branch[${branch}]`, `branch does not exist for project ${pid}`);
  }

  private insertEvent(pid: string, e: GelEvent) {
    this.db.prepare(
      `INSERT INTO events(project_id,branch,seq,event_id,type,parents_json,payload_json,hash)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(pid, e.branch, e.seq, e.id, e.type, JSON.stringify(e.parents), JSON.stringify(e.payload), e.hash);
  }

  // ---- export / import -----------------------------------------------------

  exportProject(pid: string, exportedAt = new Date().toISOString()): ExportEnvelope {
    const row = this.getProject(pid);
    if (!row) throw corrupt(`project[${pid}]`, 'project not found');
    const branches = this.listBranches(pid).map((b) => ({
      branch: b.branch, parentBranch: b.parent_branch, forkEvent: b.fork_event,
    }));
    return buildEnvelope(
      { projectId: row.project_id, name: row.name, createdAt: row.created_at, caseKind: row.case_kind },
      branches, this.allEvents(pid), exportedAt,
    );
  }

  /**
   * Two-phase import:
   *   phase 1 (prepare): validate envelope, write every event RAW to
   *     import_events_staging, mark import uncommitted. A crash here leaves only
   *     staging rows -> recoverStaging() deletes them.
   *   phase 2 (commit): promote staging rows into events/projects/branches and
   *     flip committed=1. All in one transaction, so a crash here rolls the
   *     whole promotion back while the phase-1 staging remains for recovery.
   */
  importEnvelope(raw: string): { projectId: string; recoveredStaging: string[] } {
    const env = validateEnvelope(raw);
    const importId = randomUUID();
    const prepare = this.db.transaction(() => {
      if (this.getProject(env.project.projectId)) {
        throw corrupt(`project[${env.project.projectId}]`, 'project id already present');
      }
      this.db.prepare(
        `INSERT INTO import_staging(import_id,project_id,committed,created_at) VALUES(?,?,0,?)`,
      ).run(importId, env.project.projectId, `import:${importId}:${env.project.createdAt}`);
      const ins = this.db.prepare(
        `INSERT INTO import_events_staging(import_id,project_id,branch,seq,event_json) VALUES(?,?,?,?,?)`);
      for (const rec of env.records) {
        const { checksum, ...ev } = rec;
        ins.run(importId, env.project.projectId, ev.branch, ev.seq, JSON.stringify(ev));
      }
    });
    prepare();

    const promote = this.db.transaction(() => {
      this.createProjectWithId(env.project.projectId, env.project.name, env.project.createdAt, env.project.caseKind);
      for (const b of env.branches) {
        this.upsertBranch(env.project.projectId, b.branch, b.parentBranch, b.forkEvent);
      }
      const rows = this.db.prepare(
        `SELECT event_json FROM import_events_staging WHERE import_id=? AND project_id=? ORDER BY branch,seq`,
      ).all(importId, env.project.projectId) as Array<{ event_json: string }>;
      for (const row of rows) this.insertEvent(env.project.projectId, JSON.parse(row.event_json) as GelEvent);
      this.db.prepare(`UPDATE import_staging SET committed=1 WHERE import_id=? AND project_id=?`)
        .run(importId, env.project.projectId);
      this.db.prepare(`DELETE FROM import_events_staging WHERE import_id=? AND project_id=?`)
        .run(importId, env.project.projectId);
    });
    promote();
    return { projectId: env.project.projectId, recoveredStaging: [] };
  }

  materialsAt(pid: string, branch: string, uptoEvent?: string): Material[] {
    return this.stateAt(pid, branch, uptoEvent).materials;
  }
}

function rowToEvent(r: EventRow): GelEvent {
  return {
    id: r.event_id, branch: r.branch, seq: r.seq, type: r.type as GelEvent['type'],
    parents: JSON.parse(r.parents_json), payload: JSON.parse(r.payload_json), hash: r.hash,
  };
}

/** Atomic file write: temp file + rename, so a crash can never leave a torn
 *  export in place. */
export async function atomicWrite(path: string, data: string) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}
export { join };
