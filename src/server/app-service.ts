import type { DB } from '../store/db'
import { ProjectStore } from '../store/project-store'
import { buildCasepack, type Scenario } from '../core/casepack'
import { ingestScenario } from '../core/ingest'
import { replay } from '../core/pipeline'
import { bundleSha, parseBundle, validateBundleSemantics, writeBundleAtomic, type Bundle } from '../core/bundle'
import { canonical, sha256Hex } from '../shared/identity'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { AnyEvent, Artifact } from '../core/events'

export class AppService {
  readonly store: ProjectStore
  constructor(private db: DB, private dataDir: string) {
    this.store = new ProjectStore(db)
  }

  seedIfEmpty(force = false): { projectIds: string[] } {
    const existing = this.store.listProjects()
    if (existing.length && !force) return { projectIds: existing.map((p) => p.projectId) }
    if (force) {
      this.db.exec('DELETE FROM artifacts; DELETE FROM events; DELETE FROM branches; DELETE FROM blobs; DELETE FROM projects;')
    }
    const pack = buildCasepack()
    const ids: string[] = []
    for (const sc of pack.scenarios) {
      ids.push(ingestScenario(this.db, sc).projectId)
    }
    return { projectIds: ids }
  }

  casepackMeta(): { kind: Scenario['kind']; title: string; description: string; expectations: Scenario['expectations'] }[] {
    return buildCasepack().scenarios.map((s) => ({ kind: s.kind, title: s.title, description: s.description, expectations: s.expectations }))
  }

  projectList() {
    return this.store.listProjects()
  }

  /** 组装审阅视图：分支事件 + 重放状态 + 工件 + blob 引用。 */
  review(projectId: string, branchId?: string, untilEventId?: string) {
    const branches = this.store.branches(projectId)
    const branch = branchId ?? branches[0]?.branchId ?? 'main'
    const events = this.store.eventsOnBranch(projectId, branch)
    const blobs = this.collectBlobs(events)
    const { state, artifacts } = replay(events, blobs, untilEventId ? { untilEventId } : {})
    const storedArtifacts = this.store.artifactsOnBranch(projectId, branch)
    return {
      projectId,
      branch,
      branches,
      events,
      replay: {
        diagnostics: state.diagnostics,
        invalidations: state.invalidations,
        paramsVersion: state.paramsVersion,
        ladderRevision: state.ladderRevision,
        lanesRevision: state.lanesRevision,
        bandsRevision: state.bandsRevision
      },
      artifacts: storedArtifacts.length ? storedArtifacts : artifacts.map((a) => ({ ...a, valid: true, supersededBy: null, producedByEvent: '' })),
      imageIds: [...blobs.keys()]
    }
  }

  private collectBlobs(events: AnyEvent[]): Map<string, Uint8Array> {
    const map = new Map<string, Uint8Array>()
    for (const e of events) {
      if (e.type === 'image_added') {
        const bytes = this.store.getBlob(e.imageId)
        if (bytes) map.set(e.imageId, bytes)
      }
    }
    return map
  }

  imagePng(projectId: string, imageId: string): Uint8Array | null {
    void projectId
    return this.store.getBlob(imageId)
  }

  exportBundle(projectId: string): { path: string; sha: string } {
    const events = this.store.allEvents(projectId)
    const branches = this.store.branches(projectId)
    const blobs = this.collectBlobs(events)
    const project = this.db.prepare('SELECT project_id projectId,name,created_at createdAt,head_branch headBranch FROM projects WHERE project_id=?').get(projectId) as {
      projectId: string
      name: string
      createdAt: string
      headBranch: string
    }
    const artifacts: Bundle['artifacts'] = []
    for (const br of branches) {
      for (const a of this.store.artifactsOnBranch(projectId, br.branchId)) {
        artifacts.push({ ...a, branchId: br.branchId })
      }
    }
    const bundle: Bundle = {
      format: 'gel-workbench-bundle',
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      project,
      branches: branches.map((b) => ({ ...b, createdAt: new Date().toISOString() })),
      events,
      artifacts,
      blobs: [...blobs.entries()].map(([blobId, content]) => ({
        blobId,
        sha256: sha256Hex(content),
        byteLength: content.length,
        b64: Buffer.from(content).toString('base64')
      }))
    }
    const sha = bundleSha(bundle).bundleSha
    const path = join(this.dataDir, `${projectId}.gelbundle.json`)
    writeBundleAtomic(path, bundle)
    return { path, sha }
  }

  /** 单事务导入；任何环节失败整体回滚 —— 半写不会留下半个项目。 */
  importBundle(text: string, opts: { simulateCrashBeforeCommit?: boolean } = {}): { projectId: string; sha: string } {
    const bundle = parseBundle(text)
    validateBundleSemantics(bundle)
    const sha = bundleSha(bundle).bundleSha
    const pid = bundle.project.projectId
    const run = (b: Bundle) => {
      this.db.prepare('INSERT INTO projects(project_id,name,created_at,head_branch) VALUES(?,?,?,?)').run(pid, b.project.name, b.project.createdAt, b.project.headBranch)
      for (const br of b.branches) {
        this.db
          .prepare('INSERT INTO branches(branch_id,project_id,parent_branch,forked_from_event,label,created_at) VALUES(?,?,?,?,?,?)')
          .run(br.branchId, pid, br.parentBranch, br.forkedFromEvent, br.label, br.createdAt)
      }
      const insEv = this.db.prepare('INSERT INTO events(event_id,project_id,branch_id,seq,parent_id,at,type,payload,sha) VALUES(?,?,?,?,?,?,?,?,?)')
      for (const e of b.events) {
        insEv.run(e.eventId, pid, e.branchId, e.seq, e.parentId, e.at, e.type, canonical(e), sha256Hex(canonical(e)))
      }
      const insArt = this.db.prepare(
        'INSERT INTO artifacts(artifact_id,project_id,kind,produced_by_event,branch_id,valid,superseded_by,payload,sha) VALUES(?,?,?,?,?,?,?,?,?)'
      )
      for (const a of b.artifacts) {
        const art: Artifact = { ...a } as Artifact
        insArt.run(a.artifactId, pid, a.kind, a.producedByEvent, a.branchId, a.valid ? 1 : 0, a.supersededBy, canonical(art), sha256Hex(canonical(art)))
      }
      for (const blob of b.blobs) {
        const content = new Uint8Array(Buffer.from(blob.b64, 'base64'))
        if (sha256Hex(content) !== blob.sha256) {
          throw new Error(`blob ${blob.blobId} sha256 不一致`)
        }
        this.store.putBlob(blob.blobId, content)
      }
      if (opts.simulateCrashBeforeCommit) throw new Error('SIMULATED_CRASH_BEFORE_COMMIT')
    }
    this.db.exec('BEGIN')
    try {
      run(bundle)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { projectId: pid, sha }
  }

  readBundleFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  /** 导出 -> 删除该项目全部行 -> 再导入；验证身份/顺序/来源关系保持。 */
  roundtrip(projectId: string): { projectId: string; sha: string; before: string[]; after: string[] } {
    const { path, sha } = this.exportBundle(projectId)
    const before = this.store.eventsOnBranch(projectId, 'main').map((e) => e.eventId)
    const text = readFileSync(path, 'utf8')
    for (const table of ['artifacts', 'events', 'branches', 'projects']) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId)
    }
    this.importBundle(text)
    const after = this.store.eventsOnBranch(projectId, 'main').map((e) => e.eventId)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('往返后事件身份/顺序发生变化')
    }
    return { projectId, sha, before, after }
  }
}
