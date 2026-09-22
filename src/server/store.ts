import type {
  BandCenterMaterial, CalibrationData, DerivedRow, FrontCurveMaterial, GelEvent,
  Id, LadderMaterial, Material, MwEstimateData,
} from '../shared/types.js';
import { digestOf, eventId } from '../domain/util.js';
import { fitRuler, inferMw, RULER_V1, type RulerParams } from '../domain/calibration.js';
import { buildArchive, parseArchive, type GelArchive } from '../domain/archive.js';
import { commitSeq, committedSeq, type DB } from './db.js';

export interface ParamSet { ruler: RulerParams }

export function currentParams(db: DB): ParamSet {
  const row = db.prepare("SELECT value FROM meta WHERE key='params'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { ruler: RULER_V1 };
}
export function saveParams(db: DB, p: ParamSet): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('params', JSON.stringify(p));
}

// ---------- 材料（不可变层） ----------

export function insertMaterial(db: DB, m: Material, seq: number, blob?: Uint8Array): void {
  db.prepare('INSERT INTO materials(id,kind,seq,json) VALUES(?,?,?,?)')
    .run(m.id, m.kind, seq, JSON.stringify(m));
  if (blob) db.prepare('INSERT INTO blobs(material_id,data) VALUES(?,?)').run(m.id, blob);
}

export function getMaterial<T extends Material = Material>(db: DB, id: Id): T | undefined {
  const row = db.prepare('SELECT json FROM materials WHERE id=?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as T) : undefined;
}

export function listMaterials(db: DB): Material[] {
  const rows = db.prepare('SELECT json FROM materials ORDER BY seq, id').all() as { json: string }[];
  return rows.map((r) => JSON.parse(r.json));
}

export function getBlob(db: DB, materialId: Id): Uint8Array | undefined {
  const row = db.prepare('SELECT data FROM blobs WHERE material_id=?').get(materialId) as { data: Uint8Array } | undefined;
  return row?.data;
}

// ---------- 事件（决定层，追加式） ----------

export interface EventInput {
  kind: GelEvent['kind'];
  summary: string;
  payload: unknown;
  parents?: Id[];
}

/** 追加事件并在同一事务里执行派生写入，保证半写可恢复。 */
export function appendEvent(db: DB, input: EventInput, derive?: (seq: number) => void): GelEvent {
  const seq = committedSeq(db) + 1;
  const params = currentParams(db);
  const evt: GelEvent = {
    id: eventId(seq),
    seq,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    param_version: params.ruler.version,
    input_digest: digestOf({ payload: input.payload, parents: input.parents ?? [], param_version: params.ruler.version }),
    parents: input.parents ?? [],
    created_at: new Date().toISOString(),
  };
  commitSeq(db, seq, () => {
    db.prepare('INSERT INTO events(id,seq,kind,json) VALUES(?,?,?,?)')
      .run(evt.id, seq, evt.kind, JSON.stringify(evt));
    derive?.(seq);
  });
  return evt;
}

export function listEvents(db: DB): GelEvent[] {
  const rows = db.prepare('SELECT json FROM events ORDER BY seq').all() as { json: string }[];
  return rows.map((r) => JSON.parse(r.json));
}

// ---------- 派生层（可失效、可重放） ----------

function insertDerived(db: DB, row: Omit<DerivedRow, 'invalidated_seq' | 'invalidated_by'>, seq: number): void {
  db.prepare('INSERT INTO derived(id,subject_id,kind,version,seq,invalidated_seq,invalidated_by,json) VALUES(?,?,?,?,?,?,?,?)')
    .run(row.id, row.subject_id, row.kind, row.version, seq, null, null, JSON.stringify(row.data));
}

function nextVersion(db: DB, subjectId: Id): number {
  const row = db.prepare('SELECT MAX(version) v FROM derived WHERE subject_id=?').get(subjectId) as { v: number | null };
  return (row.v ?? 0) + 1;
}

/** 计算某图像的标尺与全部条带估计，作为某个事件序号下的新版本写入。 */
export function computeImageDerived(db: DB, imageId: Id, seq: number, params: ParamSet): void {
  const ladder = listMaterials(db).find((m): m is LadderMaterial => m.kind === 'ladder' && m.image_id === imageId && !m.id.includes('nonmono'));
  const curve = listMaterials(db).find((m): m is FrontCurveMaterial => m.kind === 'front-curve' && m.image_id === imageId);
  if (!ladder || !curve) return;
  const fit = fitRuler(ladder, curve, params.ruler);
  if (fit.status === 'ok') {
    const cal = fit.value;
    insertDerived(db, {
      id: `${cal.subject_id}:v${nextVersion(db, cal.subject_id)}`,
      subject_id: cal.subject_id, kind: 'calibration', version: nextVersion(db, cal.subject_id), seq, data: cal,
    }, seq);
    const bands = listMaterials(db).filter((m): m is BandCenterMaterial => m.kind === 'band-center' && m.image_id === imageId);
    const byLane = new Map<number, BandCenterMaterial[]>();
    for (const b of bands) {
      const arr = byLane.get(b.lane_index) ?? [];
      arr.push(b);
      byLane.set(b.lane_index, arr);
    }
    for (const b of [...bands].sort((a, b2) => a.lane_index - b2.lane_index || a.pixel.y - b2.pixel.y)) {
      const est = inferMw(b, byLane.get(b.lane_index) ?? [], cal, curve, params.ruler);
      insertDerived(db, {
        id: `${est.subject_id}:v${nextVersion(db, est.subject_id)}`,
        subject_id: est.subject_id, kind: 'mw-estimate', version: nextVersion(db, est.subject_id), seq, data: est,
      }, seq);
    }
  } else {
    // 标尺本身失败也要留痕：作为诊断事件载荷由调用方处理
  }
}

export function liveDerived(db: DB, asOfSeq?: number): DerivedRow[] {
  const seqLimit = asOfSeq ?? committedSeq(db);
  const rows = db.prepare(
    `SELECT * FROM derived d WHERE d.seq <= ?
     AND (d.invalidated_seq IS NULL OR d.invalidated_seq > ?)
     AND d.version = (SELECT MAX(version) FROM derived d2 WHERE d2.subject_id=d.subject_id AND d2.seq <= ?
       AND (d2.invalidated_seq IS NULL OR d2.invalidated_seq > ?))
     ORDER BY d.subject_id`
  ).all(seqLimit, seqLimit, seqLimit, seqLimit) as (Omit<DerivedRow, 'data'> & { json: string })[];
  return rows.map((r) => ({ ...r, data: JSON.parse(r.json) }));
}

/**
 * 局部失效：只让父级依赖闭包中包含被改材料的派生行失效并重算。
 * 返回受影响的 subject_id 列表（机器可读）。
 */
export function invalidateFrom(db: DB, changedMaterialIds: Id[], eventSeq: number, eventId: Id, params: ParamSet): Id[] {
  const live = liveDerived(db);
  const changed = new Set<Id>(changedMaterialIds);
  // 闭包：若某 subject 失效，则依赖它的行也失效
  let grew = true;
  const deadSubjects = new Set<Id>();
  while (grew) {
    grew = false;
    for (const row of live) {
      if (deadSubjects.has(row.subject_id)) continue;
      const parents = (row.data as CalibrationData | MwEstimateData).parents;
      if (parents.some((p) => changed.has(p) || deadSubjects.has(p))) {
        deadSubjects.add(row.subject_id);
        grew = true;
      }
    }
  }
  const affectedImages = new Set<Id>();
  for (const row of live) {
    if (!deadSubjects.has(row.subject_id)) continue;
    db.prepare('UPDATE derived SET invalidated_seq=?, invalidated_by=? WHERE id=?').run(eventSeq, eventId, row.id);
    const img = (row.data as CalibrationData | MwEstimateData).image_id;
    if (img) affectedImages.add(img);
  }
  // 只重算受影响图像的派生层
  for (const img of affectedImages) computeImageDerived(db, img, eventSeq, params);
  return [...deadSubjects].sort();
}

// ---------- 决定 ----------

export function applyDecision(db: DB, subjectId: Id, decision: 'accepted' | 'rejected' | 'contested', seq: number): void {
  const live = liveDerived(db).filter((r) => r.subject_id === subjectId);
  for (const row of live) {
    const data = row.data as MwEstimateData;
    data.decision = decision;
    db.prepare('UPDATE derived SET json=? WHERE id=?').run(JSON.stringify(data), row.id);
  }
}

// ---------- 状态快照 ----------

export function stateAsOf(db: DB, seq?: number) {
  return {
    committed_seq: committedSeq(db),
    view_seq: seq ?? committedSeq(db),
    params: currentParams(db),
    materials: listMaterials(db),
    derived: liveDerived(db, seq),
    events: listEvents(db).filter((e) => (seq == null || e.seq <= seq)),
  };
}

// ---------- 导出 / 导入 ----------

export function exportArchive(db: DB): GelArchive {
  const materials = (db.prepare('SELECT id,kind,seq,json FROM materials ORDER BY seq,id').all() as { id: string; kind: string; seq: number; json: string }[])
    .map((r) => ({ id: r.id, kind: r.kind, seq: r.seq, json: JSON.parse(r.json) as Material }));
  const events = listEvents(db);
  const derived = (db.prepare('SELECT * FROM derived ORDER BY subject_id, version').all() as (DerivedRow & { json: string })[])
    .map((r) => ({ ...r, json: JSON.parse(r.json) }));
  const blobs = (db.prepare('SELECT material_id, data FROM blobs ORDER BY material_id').all() as { material_id: string; data: Uint8Array }[])
    .map((r) => ({ material_id: r.material_id, data_base64: Buffer.from(r.data).toString('base64') }));
  return buildArchive({ exported_seq: committedSeq(db), materials, events, derived, blobs });
}

export interface ImportReport { status: 'ok' | 'corrupt_format' | 'semantic_unsolvable' | 'resource_exhausted'; inserted: number; duplicates: number; diagnostics: unknown[] }

export function importArchive(db: DB, raw: Uint8Array): ImportReport {
  const parsed = parseArchive(raw);
  if (parsed.status !== 'ok') return { status: parsed.status, inserted: 0, duplicates: 0, diagnostics: parsed.diagnostics };
  const archive = parsed.value;
  let inserted = 0, duplicates = 0;
  const maxSeq = archive.exported_seq;
  commitSeq(db, Math.max(committedSeq(db), maxSeq), () => {
    for (const m of archive.materials) {
      const exists = db.prepare('SELECT 1 FROM materials WHERE id=?').get(m.id);
      if (exists) { duplicates++; continue; }
      db.prepare('INSERT INTO materials(id,kind,seq,json) VALUES(?,?,?,?)').run(m.id, m.kind, m.seq, JSON.stringify(m.json));
      inserted++;
    }
    for (const b of archive.blobs) {
      const exists = db.prepare('SELECT 1 FROM blobs WHERE material_id=?').get(b.material_id);
      if (!exists) db.prepare('INSERT INTO blobs(material_id,data) VALUES(?,?)').run(b.material_id, Buffer.from(b.data_base64, 'base64'));
    }
    for (const e of archive.events) {
      const exists = db.prepare('SELECT 1 FROM events WHERE id=?').get(e.id);
      if (exists) { duplicates++; continue; }
      db.prepare('INSERT INTO events(id,seq,kind,json) VALUES(?,?,?,?)').run(e.id, e.seq, e.kind, JSON.stringify(e));
      inserted++;
    }
    for (const d of archive.derived) {
      const exists = db.prepare('SELECT 1 FROM derived WHERE id=?').get(d.id);
      if (exists) { duplicates++; continue; }
      db.prepare('INSERT INTO derived(id,subject_id,kind,version,seq,invalidated_seq,invalidated_by,json) VALUES(?,?,?,?,?,?,?,?)')
        .run(d.id, d.subject_id, d.kind, d.version, d.seq, d.invalidated_seq, d.invalidated_by, JSON.stringify(d.json));
      inserted++;
    }
  });
  return { status: 'ok', inserted, duplicates, diagnostics: parsed.diagnostics };
}
