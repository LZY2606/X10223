import { randomUUID } from 'node:crypto'
import type { DB } from './db'
import { canonical, contentId, sha256Hex } from '../shared/identity'
import type { AnyEvent, Artifact, EventBase } from '../core/events'

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export class ProjectStore {
  constructor(private db: DB) {}

  createProject(name: string, nowIso: string): { projectId: string; branchId: string; event: AnyEvent } {
    const projectId = newId('proj')
    const branchId = 'main'
    const eventId = contentId('evt', { projectId, branch: branchId, seq: 0, name })
    const event: AnyEvent = {
      eventId,
      projectId,
      branchId,
      seq: 0,
      parentId: null,
      at: nowIso,
      type: 'project_created',
      name
    } as AnyEvent
    const tx = this.db.prepare('INSERT INTO projects(project_id,name,created_at,head_branch) VALUES(?,?,?,?)')
    const be = this.db.prepare('INSERT INTO branches(branch_id,project_id,parent_branch,forked_from_event,label,created_at) VALUES(?,?,?,?,?,?)')
    const ev = this.db.prepare('INSERT INTO events(event_id,project_id,branch_id,seq,parent_id,at,type,payload,sha) VALUES(?,?,?,?,?,?,?,?,?)')
    this.db.exec('BEGIN')
    try {
      tx.run(projectId, name, nowIso, branchId)
      be.run(branchId, projectId, null, null, 'main', nowIso)
      ev.run(event.eventId, projectId, branchId, 0, null, nowIso, 'project_created', canonical(event), sha256Hex(canonical(event)))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { projectId, branchId, event }
  }

  listProjects(): { projectId: string; name: string; createdAt: string }[] {
    return this.db.prepare('SELECT project_id projectId, name, created_at createdAt FROM projects ORDER BY created_at').all() as never
  }

  /** 在分支尾部追加事件（事务内完成，顺序由 seq 决定，等价输入得到稳定事件体）。 */
  appendEvent(projectId: string, branchId: string, payload: Record<string, unknown>, nowIso: string): AnyEvent {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),-1)+1 AS nextSeq FROM events WHERE project_id=? AND branch_id=?')
      .get(projectId, branchId) as { nextSeq: number }
    const seq = row.nextSeq
    const parent = this.db
      .prepare('SELECT event_id FROM events WHERE project_id=? AND branch_id=? ORDER BY seq DESC LIMIT 1')
      .get(projectId, branchId) as { event_id?: string } | undefined
    const eventId = contentId('evt', { projectId, branchId, seq, payload })
    const base: EventBase = {
      eventId,
      projectId,
      branchId,
      seq,
      parentId: parent?.event_id ?? null,
      at: nowIso,
      type: payload.type as EventBase['type']
    }
    const full = { ...payload, ...base } as unknown as AnyEvent
    this.db
      .prepare('INSERT INTO events(event_id,project_id,branch_id,seq,parent_id,at,type,payload,sha) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(eventId, projectId, branchId, seq, base.parentId, nowIso, base.type, canonical(full), sha256Hex(canonical(full)))
    return full
  }

  createBranch(projectId: string, fromBranchId: string, forkEventId: string, newBranchId: string, label: string, nowIso: string): void {
    this.db
      .prepare('INSERT INTO branches(branch_id,project_id,parent_branch,forked_from_event,label,created_at) VALUES(?,?,?,?,?,?)')
      .run(newBranchId, projectId, fromBranchId, forkEventId, label, nowIso)
    // 新分支以 fork 点事件链为父链：复制祖先事件到新分支视图（保持独立 seq 命名空间）
    const ancestors = this.ancestorEvents(projectId, fromBranchId, forkEventId)
    const ins = this.db.prepare('INSERT INTO events(event_id,project_id,branch_id,seq,parent_id,at,type,payload,sha) VALUES(?,?,?,?,?,?,?,?,?)')
    this.db.exec('BEGIN')
    try {
      ancestors.forEach((e, idx) => {
        const copy = { ...e, branchId: newBranchId } as AnyEvent
        ins.run(e.eventId, projectId, newBranchId, idx, idx === 0 ? null : ancestors[idx - 1].eventId, e.at, e.type, canonical(copy), sha256Hex(canonical(copy)))
      })
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  ancestorEvents(projectId: string, branchId: string, untilEventId: string): AnyEvent[] {
    const all = this.eventsOnBranch(projectId, branchId)
    const idx = all.findIndex((e) => e.eventId === untilEventId)
    if (idx < 0) throw new Error(`fork 点事件 ${untilEventId} 不在分支 ${branchId}`)
    return all.slice(0, idx + 1)
  }

  eventsOnBranch(projectId: string, branchId: string): AnyEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM events WHERE project_id=? AND branch_id=? ORDER BY seq ASC')
      .all(projectId, branchId) as { payload: string }[]
    return rows.map((r) => JSON.parse(r.payload) as AnyEvent)
  }

  allEvents(projectId: string): AnyEvent[] {
    // 以 main 为权威分支；其他分支独有事件单独返回（去重 event_id）
    const rows = this.db
      .prepare('SELECT payload FROM events WHERE project_id=? ORDER BY branch_id, seq')
      .all(projectId) as { payload: string }[]
    const seen = new Set<string>()
    const out: AnyEvent[] = []
    for (const r of rows) {
      const e = JSON.parse(r.payload) as AnyEvent
      if (!seen.has(e.eventId)) {
        seen.add(e.eventId)
        out.push(e)
      }
    }
    return out
  }

  branches(projectId: string): { branchId: string; parentBranch: string | null; label: string; forkedFromEvent: string | null }[] {
    return this.db
      .prepare('SELECT branch_id branchId, parent_branch parentBranch, label, forked_from_event forkedFromEvent FROM branches WHERE project_id=? ORDER BY created_at')
      .all(projectId) as never
  }

  putArtifact(projectId: string, artifact: Artifact, producedByEvent: string, branchId: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO artifacts(artifact_id,project_id,kind,produced_by_event,branch_id,valid,superseded_by,payload,sha) VALUES(?,?,?,?,?,1,NULL,?,?)'
      )
      .run(
        artifact.artifactId,
        projectId,
        artifact.kind,
        producedByEvent,
        branchId,
        canonical(artifact),
        sha256Hex(canonical(artifact))
      )
  }

  /** 局部失效：旧工件标记失效但保留（历史可见），不物理删除。 */
  invalidateArtifact(projectId: string, artifactId: string, supersededBy: string): void {
    this.db.prepare('UPDATE artifacts SET valid=0, superseded_by=? WHERE project_id=? AND artifact_id=?').run(supersededBy, projectId, artifactId)
  }

  artifactsOnBranch(projectId: string, branchId: string): (Artifact & { valid: boolean; supersededBy: string | null; producedByEvent: string })[] {
    const rows = this.db
      .prepare('SELECT payload, valid, superseded_by supersededBy, produced_by_event producedByEvent FROM artifacts WHERE project_id=? AND branch_id=? ORDER BY rowid')
      .all(projectId, branchId) as { payload: string; valid: number; supersededBy: string | null; producedByEvent: string }[]
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as Artifact), valid: r.valid === 1, supersededBy: r.supersededBy, producedByEvent: r.producedByEvent }))
  }

  putBlob(blobId: string, content: Uint8Array): { sha256: string; byteLength: number } {
    const sha = sha256Hex(content)
    const exists = this.db.prepare('SELECT 1 FROM blobs WHERE blob_id=?').get(blobId)
    if (!exists) this.db.prepare('INSERT INTO blobs(blob_id,content,sha256,byte_length) VALUES(?,?,?,?)').run(blobId, Buffer.from(content), sha, content.length)
    return { sha256: sha, byteLength: content.length }
  }

  getBlob(blobId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT content FROM blobs WHERE blob_id=?').get(blobId) as { content: Uint8Array } | undefined
    return row ? new Uint8Array(row.content) : null
  }
}
