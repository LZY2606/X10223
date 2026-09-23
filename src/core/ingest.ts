import type { DB } from '../store/db'
import { ProjectStore, newId } from '../store/project-store'
import { canonical, contentId } from '../shared/identity'
import type { Scenario } from './casepack'
import type { AnyEvent, BandCenter, LadderNominal, LaneBoundary } from './events'
import { replay } from './pipeline'
import type { Artifact } from './events'

export function nowIso(): string {
  return new Date().toISOString()
}

/** 把一个案例场景装载为一个项目；主分支按基线叙事，反例以分支/修订事件表达。 */
export function ingestScenario(db: DB, sc: Scenario, ts: string = nowIso()): { projectId: string } {
  const store = new ProjectStore(db)
  const { projectId } = store.createProject(sc.title, ts)
  const imageId = contentId('img', { scenario: sc.kind, w: sc.width, h: sc.height, sha: sc.png.length })

  const blob = store.putBlob(imageId, sc.png)
  const seq = (n: number) => n

  const events: Record<string, unknown>[] = []
  events.push({
    type: 'image_added',
    imageId,
    name: `${sc.kind}.png`,
    width: sc.rotationDeg === 90 || sc.rotationDeg === 270 ? sc.height : sc.width,
    height: sc.rotationDeg === 90 || sc.rotationDeg === 270 ? sc.width : sc.height,
    sha256: blob.sha256,
    byteLength: blob.byteLength,
    note: sc.description
  })
  events.push({ type: 'orientation_declared', imageId, rotationDeg: sc.rotationDeg, rawStatement: `拍摄方向：需顺时针旋转 ${sc.rotationDeg}° 使迁移向下`, basis: undefined })
  events.push({
    type: 'exposure_declared',
    imageId,
    exposure: { value: sc.exposureMs, unit: 'ms', raw: `${sc.exposureMs} ms` },
    rawStatement: `曝光 ${sc.exposureMs} ms`,
    saturationGray: sc.saturationGray
  })

  // lane 边界：使用真值折线（像素坐标），作为人工核对的来源
  const lanes: LaneBoundary[] = sc.laneLabels.map((lab, i) => ({
    laneId: lab.laneId,
    label: `L${i + 1}${lab.isLadder ? ' ladder' : ''}`,
    isLadder: lab.isLadder,
    spine: sc.spineTruth[i].map((p) => ({ x: p.x, y: p.y })),
    halfWidth: 30
  }))
  events.push({ type: 'lane_boundaries_set', imageId, lanes, revision: 1, source: 'manual' })

  // ladder 标称
  const entries: LadderNominal[] = sc.ladder.map((l) => ({ slot: l.slot, nominal: { value: l.nominalBp, unit: 'bp' as const, raw: l.raw }, raw: l.raw, declaredMissing: l.declaredMissing }))
  events.push({
    type: 'ladder_nominal_set',
    ladderLaneId: 'lane_1',
    maker: 'synthetic-100bp-ladder',
    unit: 'bp' as const,
    entries,
    rawText: sc.ladder.map((l) => l.raw).join(', '),
    revision: 1
  })

  // 条带中心：来自真值（像素级来源，保留浮点原始表示）
  const bands: BandCenter[] = sc.bandsTruth.map((b) => {
    const laneId = sc.laneLabels[b.lane].laneId
    return {
      bandId: contentId('band', { lane: b.lane, r: Math.round(b.r * 1000) }),
      laneId,
      at: { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 },
      raw: `(${b.x.toFixed(1)}, ${b.y.toFixed(1)})px`,
      smear: b.smear ? true : undefined
    }
  })
  events.push({ type: 'band_centers_set', imageId, bands, revision: 1, source: 'manual' })

  const emitted: AnyEvent[] = []
  for (const payload of events) {
    const ev = store.appendEvent(projectId, 'main', payload, ts)
    emitted.push(ev)
  }
  void seq

  // 方向事件需要 basis 内容；重放后补写 basisId 到派生层（不改材料，basis 由几何派生）
  // 自动候选（detection_run）：重放得到检测/校准/推断工件
  const blobs = new Map([[imageId, sc.png]])
  const replayResult = replay(store.eventsOnBranch(projectId, 'main'), blobs)
  const detectionEvent = store.appendEvent(
    projectId,
    'main',
    { type: 'detection_run', artifactId: replayResult.state.detection?.artifactId ?? 'none', trigger: 'auto', paramsVersion: 'calib-v1' },
    ts
  )
  for (const art of replayResult.artifacts) store.putArtifact(projectId, art, detectionEvent.eventId, 'main')

  // 机读判定事件：采纳 / 未采纳都留档
  for (const exp of sc.expectations) {
    const verdict = exp.adopted ? 'accepted' : 'rejected'
    store.appendEvent(
      projectId,
      'main',
      {
        type: 'decision',
        verb: 'annotate',
        targets: exp.bandKey ? [contentId('band', { lane: sc.laneLabels.findIndex((l) => l.laneId === exp.laneId), r: 0 })] : [replayResult.state.calibration?.artifactId ?? ''],
        verdict,
        reason: exp.message,
        label: exp.code,
        adoptedArtifactIds: exp.adopted ? [replayResult.state.mw?.artifactId ?? ''] : [],
        rejectedArtifactIds: exp.adopted ? [] : [replayResult.state.mw?.artifactId ?? '']
      },
      ts
    )
  }

  // 场景特有：非单调的“改动后”标称（局部来源改动已在 v1；这里加一次修订事件以完整叙事）
  if (sc.kind === 'revision_local_failure') {
    addRevisionBranch(store, projectId, imageId, sc, ts)
  }

  return { projectId }
}

/** 修订后局部失效：开分支，移动 lane_2 一条带，重新计算并把旧工件标记 superseded。 */
function addRevisionBranch(store: ProjectStore, projectId: string, imageId: string, sc: Scenario, ts: string): void {
  const mainEvents = store.eventsOnBranch(projectId, 'main')
  const forkAt = mainEvents.find((e) => e.type === 'detection_run')!
  const branchId = 'revision-move-band'
  store.createBranch(projectId, 'main', forkAt.eventId, branchId, '人工移动 lane_2 条带（局部依赖修订）', ts)

  const movedBands: BandCenter[] = sc.bandsTruth
    .filter((b) => sc.laneLabels[b.lane].laneId === 'lane_2')
    .map((b, i) => {
      const shift = i === 0 ? 40 : 0 // 把第一条样本带下移 40px，落到标尺边缘外/局部失效
      return {
        bandId: contentId('band', { lane: b.lane, r: Math.round(b.r * 1000), rev: 2 }),
        laneId: 'lane_2',
        at: { x: Math.round(b.x * 10) / 10, y: Math.round((b.y + shift) * 10) / 10 },
        raw: `(${(b.x).toFixed(1)}, ${(b.y + shift).toFixed(1)})px 人工修订#${i + 1}`
      }
    })
  // 复制其余泳道带（分支修订仍保留全部来源）
  const rest: BandCenter[] = sc.bandsTruth
    .filter((b) => sc.laneLabels[b.lane].laneId !== 'lane_2')
    .map((b) => ({
      bandId: contentId('band', { lane: b.lane, r: Math.round(b.r * 1000) }),
      laneId: sc.laneLabels[b.lane].laneId,
      at: { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 },
      raw: `(${b.x.toFixed(1)}, ${b.y.toFixed(1)})px`
    }))
  store.appendEvent(projectId, branchId, { type: 'band_centers_set', imageId, bands: [...rest, ...movedBands], revision: 2, source: 'manual' }, ts)

  const blobs = new Map([[imageId, sc.png]])
  const r2 = replay(store.eventsOnBranch(projectId, branchId), blobs)
  const runEv = store.appendEvent(projectId, branchId, { type: 'detection_run', artifactId: r2.state.detection?.artifactId ?? 'none', trigger: 'manual', paramsVersion: 'calib-v1' }, ts)
  for (const art of r2.artifacts) store.putArtifact(projectId, art, runEv.eventId, branchId)

  // 局部失效：旧的 lane_2 推断工件被新工件取代（仅依赖子图）
  store.appendEvent(
    projectId,
    branchId,
    {
      type: 'decision',
      verb: 'manual_bands',
      targets: ['lane_2'],
      verdict: 'accepted',
      reason: '人工移动 lane_2 条带：旧推断局部失效，影响仅限该带依赖子图',
      label: 'local_invalidation',
      adoptedArtifactIds: [r2.state.mw?.artifactId ?? '']
    },
    ts
  )
}

export function artifactDigest(art: Artifact): string {
  return contentId('artsha', canonical(art))
}
