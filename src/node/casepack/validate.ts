// 导入校验：格式损坏 / 语义无解 / 预算耗尽三类严格区分；字段带 JSON Pointer。
import { D, diag } from '../../shared/diagnostics.js';
import { asNumber, asString, asUnit, cursor, requireField, requireObject } from '../../shared/validate.js';
import type { Diagnostic, ExportBundle } from '../../shared/types.js';

export type Classified =
  | { ok: true; bundle: ExportBundle; diagnostics: Diagnostic[] }
  | { ok: false; failureClass: 'format_corrupt' | 'semantic_impossible' | 'budget_exhausted'; diagnostics: Diagnostic[] };

export function parseBundle(text: string, budget = { maxEvents: 50000 }): Classified {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      failureClass: 'format_corrupt',
      diagnostics: [
        diag(D.FORMAT_JSON_CORRUPT, 'error', `JSON 解析失败: ${(err as Error).message}`, '/'),
      ],
    };
  }
  const diagnostics: Diagnostic[] = [];
  const c = cursor('');
  if (!requireObject(json, c, diagnostics)) {
    return { ok: false, failureClass: 'format_corrupt', diagnostics };
  }
  const root = json;
  const fmt = requireField(root, 'format', c, diagnostics);
  if (fmt !== 'gel-ladder-bench-archive') {
    diagnostics.push(diag(D.FORMAT_UNSUPPORTED, 'error', `未知归档格式: ${String(fmt)}`, '/format'));
  }
  const project = requireField(root, 'project', c, diagnostics);
  const events = requireField(root, 'events', c, diagnostics);
  const branches = requireField(root, 'branches', c, diagnostics);
  const materials = requireField(root, 'materials', c, diagnostics);

  if (!Array.isArray(events)) {
    diagnostics.push(diag(D.FORMAT_BAD_TYPE, 'error', 'events 必须为数组', '/events'));
  } else if (events.length > budget.maxEvents) {
    return {
      ok: false,
      failureClass: 'budget_exhausted',
      diagnostics: [diag(D.BUDGET_EXHAUSTED, 'error', `事件数 ${events.length} 超过预算 ${budget.maxEvents}`, '/events')],
    };
  }

  // 逐字段校验（带位置）
  if (requireObject(project, cursor('/project'), diagnostics)) {
    asString(requireField(project, 'id', cursor('/project'), diagnostics), cursor('/project/id'), diagnostics);
    asString(requireField(project, 'name', cursor('/project'), diagnostics), cursor('/project/name'), diagnostics);
  }
  if (Array.isArray(branches)) {
    branches.forEach((b, i) => {
      const bc = cursor(`/branches/${i}`);
      if (!requireObject(b, bc, diagnostics)) return;
      asString(requireField(b, 'id', bc, diagnostics), bc.push('id'), diagnostics);
      asString(requireField(b, 'name', bc, diagnostics), bc.push('name'), diagnostics);
    });
  }
  if (Array.isArray(materials)) {
    materials.forEach((m, i) => {
      const mc = cursor(`/materials/${i}`);
      if (!requireObject(m, mc, diagnostics)) return;
      const kind = requireField(m, 'kind', mc, diagnostics);
      asString(m.id, mc.push('id'), diagnostics);
      if (kind === 'image') {
        asNumber(m.widthPx, mc.push('widthPx'), diagnostics, { finite: true, positive: true });
        asNumber(m.heightPx, mc.push('heightPx'), diagnostics, { finite: true, positive: true });
        const acq = requireField(m, 'acquisition', mc, diagnostics);
        if (requireObject(acq, mc.push('acquisition'), diagnostics)) {
          asNumber(acq.orientationDegrees, mc.push('acquisition').push('orientationDegrees'), diagnostics);
        }
      } else if (kind === 'ladder_spec') {
        const bands = requireField(m, 'bands', mc, diagnostics);
        if (Array.isArray(bands)) {
          bands.forEach((b2, j) => {
            const lc = cursor(`/materials/${i}/bands/${j}`);
            if (!requireObject(b2, lc, diagnostics)) return;
            const nominal = requireField(b2, 'nominal', lc, diagnostics);
            if (requireObject(nominal, lc.push('nominal'), diagnostics)) {
              asNumber(nominal.value, lc.push('nominal').push('value'), diagnostics, { finite: true, positive: true });
              asUnit(nominal.unit, lc.push('nominal').push('unit'), diagnostics);
            }
          });
        }
      } else {
        diagnostics.push(diag(D.FORMAT_BAD_TYPE, 'error', `未知材料类型: ${String(kind)}`, mc.push('kind').path));
      }
    });
  }

  if (diagnostics.some((d) => d.code.startsWith('E_FORMAT') || d.code === D.FORMAT_UNSUPPORTED)) {
    return { ok: false, failureClass: 'format_corrupt', diagnostics };
  }

  // 语义检查
  const semantic: Diagnostic[] = [];
  if (Array.isArray(events) && Array.isArray(branches)) {
    const branchIds = new Set((branches as Array<{ id: string }>).map((b) => b.id));
    const seenIds = new Set<string>();
    events.forEach((e, i) => {
      const ec = cursor(`/events/${i}`);
      if (!requireObject(e, ec, semantic)) return;
      const id = e.id as string;
      if (seenIds.has(id)) {
        semantic.push(diag(D.FORMAT_BAD_TYPE, 'error', `事件 id 重复: ${id}`, ec.push('id').path));
      }
      seenIds.add(id);
      if (!branchIds.has(e.branchId as string)) {
        semantic.push(diag(D.DECISION_CONFLICT, 'error', `事件引用未知分支: ${String(e.branchId)}`, ec.push('branchId').path));
      }
    });
    // 分支内 seq 必须连续
    const byBranch = new Map<string, number[]>();
    for (const e of events as Array<{ branchId: string; seq: number }>) {
      const arr = byBranch.get(e.branchId) ?? [];
      arr.push(e.seq);
      byBranch.set(e.branchId, arr);
    }
    for (const [bid, seqs] of byBranch) {
      const sorted = [...seqs].sort((a, b) => a - b);
      sorted.forEach((seq, i) => {
        if (seq !== i + 1) {
          semantic.push(
            diag(D.FORMAT_BAD_TYPE, 'error', `分支 ${bid} 的 seq 不连续（位置 ${i} 得到 ${seq}）`, `/branches/${bid}/seq`),
          );
        }
      });
    }
  }
  if (semantic.length) {
    return { ok: false, failureClass: 'semantic_impossible', diagnostics: semantic };
  }
  return { ok: true, bundle: json as ExportBundle, diagnostics };
}
