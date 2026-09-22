import type { DatabaseSync } from 'node:sqlite';
import type { DecisionEvent, DerivedRecord, Material } from '../domain/types';
import { canonical, contentId, eventId, sha256Hex } from '../domain/ids';

export interface ProjectRow {
  id: string;
  name: string;
  kind: string;
  headEventId: string | null;
  createdLogical: number;
  spec: Record<string, unknown>;
}

/**
 * 存储层：材料（不可变）与决定（事件溯源）分层。
 * 材料可以被同一逻辑 id 的新版本取代（superseded_by），旧版本永不删除，
 * 这样旧事件回放时可恢复当时的依赖版本。
 */
export class Store {
  constructor(private db: DatabaseSync) {}

  // ---------- meta / clock ----------
  nextLogicalClock(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='clock'`).get() as { value: string } | undefined;
    const next = (row ? Number(row.value) : 0) + 1;
    this.db
      .prepare(`INSERT INTO meta(key,value) VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(next));
    return next;
  }

  currentClock(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='clock'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  // ---------- blobs ----------
  putBlob(bytes: Buffer, format: string): string {
    const sha = sha256Hex(bytes.toString('binary'));
    this.db
      .prepare(`INSERT OR IGNORE INTO blobs(sha256,format,bytes,size) VALUES(?,?,?,?)`)
      .run(sha, format, bytes, bytes.length);
    return sha;
  }

  getBlob(sha: string): { bytes: Buffer; format: string } | undefined {
    const row = this.db.prepare(`SELECT bytes, format FROM blobs WHERE sha256=?`).get(sha) as
      | { bytes: Buffer; format: string }
      | undefined;
    return row ? { bytes: Buffer.from(row.bytes), format: row.format } : undefined;
  }

  // ---------- projects ----------
  createProject(name: string, kind: string, spec: Record<string, unknown>, clock?: number): ProjectRow {
    const id = contentId('project', { name, kind, spec });
    const clk = clock ?? this.nextLogicalClock();
    this.db
      .prepare(`INSERT INTO projects(id,name,kind,head_event_id,created_logical,spec_json) VALUES(?,?,?,?,?,?)`)
      .run(id, name, kind, null, clk, canonical(spec));
    this.db
      .prepare(`INSERT INTO branch_heads(project_id,branch,head_event_id,seq_last) VALUES(?,?,NULL,0)`)
      .run(id, 'main');
    const event = this.appendEvent(id, null, 'main', 'project_created', { projectId: id, name, kind }, 'system', {
      spec,
    });
    this.setHead(id, 'main', event.id, event.seq);
    return { id, name, kind, headEventId: event.id, createdLogical: clk, spec };
  }

  listProjects(): ProjectRow[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY created_logical`).all() as Record<string, unknown>[];
    return rows.map(this.rowToProject);
  }

  getProject(id: string): ProjectRow | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : undefined;
  }

  private rowToProject = (row: Record<string, unknown>): ProjectRow => ({
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as string,
    headEventId: (row.head_event_id as string | null) ?? null,
    createdLogical: Number(row.created_logical),
    spec: JSON.parse(row.spec_json as string),
  });


  /** 导入用：按原身份原样写入项目（不产生新事件） */
  insertProjectRaw(row: ProjectRow) {
    this.db
      .prepare(`INSERT OR REPLACE INTO projects(id,name,kind,head_event_id,created_logical,spec_json) VALUES(?,?,?,?,?,?)`)
      .run(row.id, row.name, row.kind, row.headEventId, row.createdLogical, canonical(row.spec));
  }

  /** 导入用：按原 id/seq/父链原样插入事件（身份与顺序保持） */
  appendEventRaw(e: DecisionEvent) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events(id,project_id,seq,parent_id,branch,type,payload_json,author,rationale_json,logical_clock)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(e.id, e.projectId, e.seq, e.parentId, e.branch, e.type, canonical(e.payload), e.author, canonical(e.rationale), e.logicalClock);
  }

  setMaterialLinks(projectId: string, id: string, createdEventId: string | null, supersededBy: string | null, supersededEventId: string | null, logicalId: string) {
    this.db
      .prepare(`UPDATE materials SET created_event_id=?, superseded_by=?, superseded_event_id=?, logical_id=? WHERE project_id=? AND id=?`)
      .run(createdEventId, supersededBy, supersededEventId, logicalId, projectId, id);
  }

  bumpClock(clock: number) {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='clock'`).get() as { value: string } | undefined;
    if (!row || Number(row.value) < clock) {
      this.db
        .prepare(`INSERT INTO meta(key,value) VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run(String(clock));
    }
  }

  // ---------- branches / events ----------
  getHead(projectId: string, branch: string): { headEventId: string | null; seq: number } {
    const row = this.db
      .prepare(`SELECT head_event_id, seq_last FROM branch_heads WHERE project_id=? AND branch=?`)
      .get(projectId, branch) as { head_event_id: string | null; seq_last: number } | undefined;
    if (!row) return { headEventId: null, seq: 0 };
    return { headEventId: row.head_event_id, seq: row.seq_last };
  }

  setHead(projectId: string, branch: string, eventIdVal: string, seq: number) {
    this.db
      .prepare(
        `INSERT INTO branch_heads(project_id,branch,head_event_id,seq_last) VALUES(?,?,?,?)
         ON CONFLICT(project_id,branch) DO UPDATE SET head_event_id=excluded.head_event_id, seq_last=excluded.seq_last`
      )
      .run(projectId, branch, eventIdVal, seq);
  }

  listBranches(projectId: string): string[] {
    const rows = this.db
      .prepare(`SELECT branch FROM branch_heads WHERE project_id=? ORDER BY branch`)
      .all(projectId) as { branch: string }[];
    return rows.map((r) => r.branch);
  }

  /**
   * 追加事件。id 由 项目+父+seq+载荷 决定 -> 等价输入得到稳定身份；
   * 同一 (project,id) 重复插入被忽略，保证重放幂等。
   */
  appendEvent(
    projectId: string,
    parentId: string | null,
    branch: string,
    type: DecisionEvent['type'],
    payload: Record<string, unknown>,
    author: DecisionEvent['author'],
    rationale: Record<string, unknown>,
    clock?: number
  ): DecisionEvent {
    const head = this.getHead(projectId, branch);
    const seq = head.seq + 1;
    const id = eventId(projectId, parentId, seq, payload);
    const clk = clock ?? this.nextLogicalClock();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events(id,project_id,seq,parent_id,branch,type,payload_json,author,rationale_json,logical_clock)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(id, projectId, seq, parentId, branch, type, canonical(payload), author, canonical(rationale), clk);
    if (head.headEventId !== id) this.setHead(projectId, branch, id, seq);
    return {
      id,
      projectId,
      seq,
      parentId,
      branch,
      type,
      payload,
      author,
      rationale,
      logicalClock: clk,
    };
  }

  listEvents(projectId: string, branch?: string): DecisionEvent[] {
    const rows = branch
      ? (this.db
          .prepare(`SELECT * FROM events WHERE project_id=? AND branch=? ORDER BY seq`)
          .all(projectId, branch) as Record<string, unknown>[])
      : (this.db.prepare(`SELECT * FROM events WHERE project_id=? ORDER BY logical_clock`).all(projectId) as Record<
          string,
          unknown
        >[]);
    return rows.map(this.rowToEvent);
  }

  /** 从根沿父链到某事件（用于回到任意旧事件恢复当时版本） */
  ancestry(projectId: string, eventIdVal: string): DecisionEvent[] {
    const byId = new Map<string, DecisionEvent>();
    for (const e of this.listEvents(projectId)) byId.set(e.id, e);
    const chain: DecisionEvent[] = [];
    let cur = byId.get(eventIdVal);
    const guard = new Set<string>();
    while (cur) {
      if (guard.has(cur.id)) break;
      guard.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }

  private rowToEvent = (row: Record<string, unknown>): DecisionEvent => ({
    id: row.id as string,
    projectId: row.project_id as string,
    seq: Number(row.seq),
    parentId: (row.parent_id as string | null) ?? null,
    branch: row.branch as string,
    type: row.type as DecisionEvent['type'],
    payload: JSON.parse(row.payload_json as string),
    author: row.author as DecisionEvent['author'],
    rationale: JSON.parse(row.rationale_json as string),
    logicalClock: Number(row.logical_clock),
  });

  // ---------- materials ----------
  putMaterial(material: Material, branch: string, createdEventId: string | null, logicalId?: string, clock?: number) {
    const clk = clock ?? this.nextLogicalClock();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO materials(id,project_id,type,body_json,logical_id,superseded_by,superseded_event_id,created_event_id,branch,logical_clock)
         VALUES(?,?,?,?,?,NULL,NULL,?,?,?)`
      )
      .run(material.id, material.projectId, material.type, canonical(material), logicalId ?? material.id, createdEventId, branch, clk);
  }

  /** 用新版本取代同 id 材料；旧行保留并记录被哪个事件取代（局部依赖追溯） */
  supersedeMaterial(projectId: string, id: string, newId: string, byEventId: string) {
    this.db
      .prepare(`UPDATE materials SET superseded_by=?, superseded_event_id=? WHERE project_id=? AND id=?`)
      .run(newId, byEventId, projectId, id);
  }

  getMaterialCurrent(projectId: string, id: string): Material | undefined {
    const row = this.db
      .prepare(`SELECT body_json FROM materials WHERE project_id=? AND id=? AND superseded_by IS NULL`)
      .get(projectId, id) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as Material) : undefined;
  }

  getMaterialVersion(projectId: string, id: string): Material | undefined {
    const row = this.db
      .prepare(`SELECT body_json FROM materials WHERE project_id=? AND id=? ORDER BY logical_clock DESC LIMIT 1`)
      .get(projectId, id) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as Material) : undefined;
  }

  listMaterialsCurrent(projectId: string): Material[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM materials WHERE project_id=? AND superseded_by IS NULL ORDER BY logical_clock`)
      .all(projectId) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as Material);
  }

  /**
   * 某事件时刻可见的材料（沿父链重放 created/superseded 关系）。
   * 在链内被取代的旧版本对该时刻不可见；“未来分支”的取代不影响旧视图。
   */
  materialsAtEvent(projectId: string, eventIdVal: string): Material[] {
    const chain = this.ancestry(projectId, eventIdVal);
    const chainIds = new Set(chain.map((e) => e.id));
    const rows = this.db
      .prepare(
        `SELECT body_json, created_event_id, superseded_event_id FROM materials WHERE project_id=?`
      )
      .all(projectId) as {
      body_json: string;
      created_event_id: string | null;
      superseded_event_id: string | null;
    }[];
    const out: Material[] = [];
    for (const r of rows) {
      if (r.created_event_id && !chainIds.has(r.created_event_id)) continue;
      if (r.superseded_event_id && chainIds.has(r.superseded_event_id)) continue;
      out.push(JSON.parse(r.body_json) as Material);
    }
    return out.sort((a, b) => a.createdAtLogical - b.createdAtLogical);
  }

  materialHistory(projectId: string, logicalId: string): Material[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM materials WHERE project_id=? AND id=? ORDER BY logical_clock`)
      .all(projectId, logicalId) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as Material);
  }


  attachCreatedEvent(projectId: string, materialIds: string[], eventIdVal: string) {
    if (materialIds.length === 0) return;
    const q = materialIds.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE materials SET created_event_id=? WHERE project_id=? AND id IN (${q})`)
      .run(eventIdVal, projectId, ...materialIds);
  }

  supersedeBandsOfLane(projectId: string, laneId: string, byEventId: string) {
    this.db
      .prepare(
        `UPDATE materials SET superseded_event_id=? WHERE project_id=? AND type='band_center'
         AND json_extract(body_json,'$.laneId')=? AND superseded_by IS NULL`
      )
      .run(byEventId, projectId, laneId);
  }

  // ---------- derived ----------
  putDerived(record: DerivedRecord) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO derived(id,project_id,kind,branch,at_event_id,subject_id,state,record_json,invalidated_by_json,logical_clock)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.branch,
        record.atEventId,
        record.subjectId,
        record.state,
        canonical(record),
        record.invalidatedBy ? canonical(record.invalidatedBy) : null,
        record.logicalClock
      );
  }

  markDerivedInvalid(projectId: string, id: string, by: DerivedRecord['invalidatedBy']) {
    this.db
      .prepare(
        `UPDATE derived SET invalidated_by_json=? WHERE project_id=? AND id=? AND invalidated_by_json IS NULL`
      )
      .run(by ? canonical(by) : null, projectId, id);
  }

  listDerivedAt(projectId: string, atEventId: string): DerivedRecord[] {
    const rows = this.db
      .prepare(`SELECT record_json FROM derived WHERE project_id=? AND at_event_id=?`)
      .all(projectId, atEventId) as { record_json: string }[];
    return rows.map((r) => JSON.parse(r.record_json) as DerivedRecord);
  }

  listDerivedAll(projectId: string): DerivedRecord[] {
    const rows = this.db
      .prepare(`SELECT record_json FROM derived WHERE project_id=? ORDER BY logical_clock`)
      .all(projectId) as { record_json: string }[];
    return rows.map((r) => JSON.parse(r.record_json) as DerivedRecord);
  }

  // ---------- import journal (半写恢复) ----------
  journalStart(projectId: string, kind: 'import' | 'export', tempPath: string | null): number {
    const info = this.db
      .prepare(`INSERT INTO import_journal(project_id,kind,started_logical,temp_path,state) VALUES(?,?,?,?, 'started')`)
      .run(projectId, kind, this.currentClock(), tempPath);
    return Number(info.lastInsertRowid);
  }

  journalFinish(id: number, state: 'committed' | 'rolled_back' | 'failed') {
    this.db.prepare(`UPDATE import_journal SET state=? WHERE id=?`).run(state, id);
  }

  listJournal(projectId: string) {
    return this.db
      .prepare(`SELECT id, kind, state, started_logical, temp_path FROM import_journal WHERE project_id=? ORDER BY id`)
      .all(projectId);
  }

  // ---------- maintenance ----------
  clearAll() {
    this.db.exec(
      `DELETE FROM derived; DELETE FROM events; DELETE FROM materials; DELETE FROM blobs; DELETE FROM branch_heads; DELETE FROM projects; DELETE FROM import_journal;
       INSERT OR REPLACE INTO meta(key,value) VALUES('clock','0');`
    );
  }

  deleteProject(projectId: string) {
    this.db.exec(
      `DELETE FROM derived WHERE project_id='${projectId.replace(/'/g, "''")}';
       DELETE FROM events WHERE project_id='${projectId.replace(/'/g, "''")}';
       DELETE FROM materials WHERE project_id='${projectId.replace(/'/g, "''")}';
       DELETE FROM branch_heads WHERE project_id='${projectId.replace(/'/g, "''")}';
       DELETE FROM import_journal WHERE project_id='${projectId.replace(/'/g, "''")}';
       DELETE FROM projects WHERE id='${projectId.replace(/'/g, "''")}';`
    );
  }
}
