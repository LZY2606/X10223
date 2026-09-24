import Database from 'better-sqlite3';
import type { CounterCaseScenario, GelEvent, ProjectBundle } from '../core/types.ts';

export interface ProjectRow {
  id: string;
  name: string;
  unit: string;
  created_at: string;
  head_seq: number;
}

export function openStore(file: string): GelStore {
  return new GelStore(file);
}

export class GelStore {
  readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        created_at TEXT NOT NULL,
        head_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        seq INTEGER NOT NULL,
        branch TEXT NOT NULL,
        parent_event_id TEXT,
        forked_from_event_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_summary TEXT NOT NULL,
        time TEXT NOT NULL,
        actor TEXT NOT NULL,
        UNIQUE(project_id, seq)
      );
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        json TEXT NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS branches (
        project_id TEXT NOT NULL REFERENCES projects(id),
        branch TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        head_event_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, branch)
      );
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_branch ON events(project_id, branch, seq);
    `);
  }

  hasProject(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id);
  }

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
  }

  createProject(id: string, name: string, unit: string, createdAt: string) {
    this.db.prepare('INSERT INTO projects(id,name,unit,created_at,head_seq) VALUES(?,?,?,?,0)').run(id, name, unit, createdAt);
  }

  putBlob(sha256: string, contentType: string, bytes: Buffer) {
    this.db.prepare('INSERT OR IGNORE INTO blobs(sha256,content_type,bytes) VALUES(?,?,?)').run(sha256, contentType, Buffer.from(bytes));
  }

  getBlob(sha256: string): { contentType: string; bytes: Buffer } | undefined {
    const row = this.db.prepare('SELECT content_type, bytes FROM blobs WHERE sha256=?').get(sha256) as
      | { content_type: string; bytes: Buffer }
      | undefined;
    return row ? { contentType: row.content_type, bytes: Buffer.from(row.bytes) } : undefined;
  }

  nextSeq(projectId: string): number {
    const row = this.db.prepare('SELECT head_seq FROM projects WHERE id=?').get(projectId) as { head_seq: number };
    return row.head_seq + 1;
  }

  /** 追加事件：seq 全局稳定递增（分支也参与全局顺序），重放得到稳定顺序。 */
  appendEvent(ev: GelEvent) {
    const tx = this.db.transaction((e: GelEvent) => {
      this.db
        .prepare(
          `INSERT INTO events(id,project_id,seq,branch,parent_event_id,forked_from_event_id,type,payload,payload_summary,time,actor)
           VALUES(@id,@project_id,@seq,@branch,@parent_event_id,@forked_from_event_id,@type,@payload,@payload_summary,@time,@actor)`,
        )
        .run({
          id: e.id,
          project_id: e.projectId,
          seq: e.seq,
          branch: e.branch,
          parent_event_id: e.parentEventId,
          forked_from_event_id: e.forkedFromEventId ?? null,
          type: e.type,
          payload: JSON.stringify(e.payload),
          payload_summary: e.payloadSummary,
          time: e.time,
          actor: e.actor,
        });
      this.db.prepare('UPDATE projects SET head_seq=? WHERE id=?').run(e.seq, e.projectId);
      this.db
        .prepare(
          `INSERT INTO branches(project_id,branch,label,description,head_event_id,seq) VALUES(@p,@b,@l,@d,@h,@s)
           ON CONFLICT(project_id,branch) DO UPDATE SET head_event_id=@h, seq=@s`,
        )
        .run({ p: e.projectId, b: e.branch, l: branchLabel(e.branch), d: '', h: e.id, s: e.seq });
    });
    tx(ev);
  }

  events(projectId: string): GelEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq').all(projectId) as EventRow[];
    return rows.map(rowToEvent);
  }

  branchEvents(projectId: string, branch: string): GelEvent[] {
    // 分支视图：main 上 fork 点之前的共享历史 + 该分支事件
    const all = this.events(projectId);
    const fork = all.filter((e) => e.branch === branch && e.forkedFromEventId).map((e) => e.forkedFromEventId!)[0];
    if (!fork) return all.filter((e) => e.branch === branch);
    const forkSeq = all.find((e) => e.id === fork)!.seq;
    return all.filter((e) => (e.branch === 'main' && e.seq <= forkSeq) || (e.branch === branch && e.seq > forkSeq));
  }

  branches(projectId: string) {
    return this.db.prepare('SELECT * FROM branches WHERE project_id=? ORDER BY seq').all(projectId) as {
      project_id: string;
      branch: string;
      label: string;
      description: string;
      head_event_id: string;
      seq: number;
    }[];
  }

  putScenario(projectId: string, sc: CounterCaseScenario) {
    this.db.prepare('INSERT OR REPLACE INTO scenarios(id,project_id,json) VALUES(?,?,?)').run(sc.id, projectId, JSON.stringify(sc));
  }

  scenarios(projectId: string): CounterCaseScenario[] {
    const rows = this.db.prepare('SELECT json FROM scenarios WHERE project_id=?').all(projectId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as CounterCaseScenario);
  }

  exportBundle(projectId: string): ProjectBundle {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as ProjectRow;
    const events = this.events(projectId);
    const shaSet = new Set<string>();
    for (const e of events) {
      const img = (e.payload as { image?: { blobSha256?: string } }).image;
      if (img?.blobSha256) shaSet.add(img.blobSha256);
    }
    const blobs = [...shaSet].map((sha) => {
      const b = this.getBlob(sha)!;
      return { sha256: sha, contentType: b.contentType, base64: b.bytes.toString('base64') };
    });
    const bundle: ProjectBundle = {
      format: 'gel-bench-bundle',
      formatVersion: 1,
      projectId,
      createdAt: project.created_at,
      blobs,
      events,
      scenarios: this.scenarios(projectId),
      checksumSha256: '',
    };
    return bundle;
  }

  /**
   * 导入整个 bundle：所有写入在单个事务内。
   * 若 blob/事件 JSON 损坏，事务回滚，既有库保持完整（半写恢复）。
   * identityConflict=true 且项目已有同 id 不同内容时抛错而不是覆盖。
   */
  importBundle(bundle: ProjectBundle, opts: { identityConflict?: 'reject' | 'adopt' } = {}): void {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(bundle.projectId) as ProjectRow | undefined;
    if (project && opts.identityConflict !== 'adopt') {
      const existing = this.exportBundle(bundle.projectId);
      if (stripChecksum(existing) !== stripChecksum({ ...bundle, checksumSha256: '' })) {
        throw new Error('IDENTITY_CONFLICT: 项目已存在且内容不同；导入被拒绝以保护身份与决定历史');
      }
      return; // 幂等：内容一致
    }
    const tx = this.db.transaction(() => {
      const name = (bundle.events.find((e) => e.type === 'project_created')?.payload as { name?: string })?.name ?? '导入项目';
      const unit = (bundle.events.find((e) => e.type === 'project_created')?.payload as { unit?: string })?.unit ?? 'bp';
      this.db.prepare('INSERT OR IGNORE INTO projects(id,name,unit,created_at,head_seq) VALUES(?,?,?,?,0)').run(bundle.projectId, name, unit, bundle.createdAt);
      for (const blob of bundle.blobs) {
        this.putBlob(blob.sha256, blob.contentType, Buffer.from(blob.base64, 'base64'));
      }
      let maxSeq = 0;
      for (const e of bundle.events) {
        maxSeq = Math.max(maxSeq, e.seq);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO events(id,project_id,seq,branch,parent_event_id,forked_from_event_id,type,payload,payload_summary,time,actor)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(e.id, e.projectId, e.seq, e.branch, e.parentEventId, e.forkedFromEventId ?? null, e.type, JSON.stringify(e.payload), e.payloadSummary, e.time, e.actor);
      }
      this.db.prepare('UPDATE projects SET head_seq=? WHERE id=?').run(maxSeq, bundle.projectId);
      for (const sc of bundle.scenarios) this.putScenario(bundle.projectId, sc);
      for (const e of bundle.events) {
        this.db
          .prepare(
            `INSERT INTO branches(project_id,branch,label,description,head_event_id,seq) VALUES(?,?,?,?,?,?)
             ON CONFLICT(project_id,branch) DO UPDATE SET head_event_id=excluded.head_event_id, seq=excluded.seq`,
          )
          .run(e.projectId, e.branch, branchLabel(e.branch), '', e.id, e.seq);
      }
    });
    tx();
  }

  close() {
    this.db.close();
  }
}

interface EventRow {
  id: string;
  project_id: string;
  seq: number;
  branch: string;
  parent_event_id: string | null;
  forked_from_event_id: string | null;
  type: string;
  payload: string;
  payload_summary: string;
  time: string;
  actor: string;
}

function rowToEvent(r: EventRow): GelEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    seq: r.seq,
    branch: r.branch,
    parentEventId: r.parent_event_id,
    forkedFromEventId: r.forked_from_event_id ?? undefined,
    type: r.type as GelEvent['type'],
    payload: JSON.parse(r.payload),
    payloadSummary: r.payload_summary,
    time: r.time,
    actor: r.actor as GelEvent['actor'],
  };
}

export function branchLabel(branch: string): string {
  const labels: Record<string, string> = {
    main: '主干 · 自动候选 vs 人工修订',
    br_orientation: '反例 · 旋转图像（坐标基准失效）',
    br_smile: '反例 · 弯曲泳道（局部标尺有效区域）',
    br_missing: '反例 · ladder 缺带（扩展段）',
    br_nonmono: '反例 · 非单调标尺（语义无解）',
    br_saturated: '反例 · 饱和/拖尾/重叠（候选与区间）',
    br_params: '分支 · 参数修订（局部失效）',
  };
  return labels[branch] ?? branch;
}

function stripChecksum(b: ProjectBundle | Omit<ProjectBundle, 'checksumSha256'>) {
  const { checksumSha256: _c, ...rest } = b as ProjectBundle;
  return JSON.stringify(rest);
}
