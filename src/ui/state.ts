import { api, type ApiBranchView } from './api-client.js';

export interface UiState {
  project: { id: string; name: string; casePackVersion: string };
  branches: Array<{ id: string; name: string; purpose: string }>;
  materials: any[];
  currentBranchId: string;
  uptoSeq?: number;
  view: ApiBranchView;
}

export async function loadProject() {
  const p = await api<{ project: UiState['project']; branches: UiState['branches'] }>('/api/project');
  return p;
}
export async function loadMaterials() {
  const m = await api<{ materials: any[] }>('/api/materials');
  return m.materials;
}
export async function loadBranch(branchId: string, seq?: number) {
  const q = new URLSearchParams({ id: branchId });
  if (seq !== undefined) q.set('seq', String(seq));
  return api<ApiBranchView>(`/api/branch?${q}`);
}

export function materialOf(materials: any[], type: string) {
  return materials.find((m) => m.type === type);
}
export function allBands(materials: any[]) {
  return materialOf(materials, 'band-annotation')?.bands ?? [];
}
export function lanes(materials: any[]) {
  return materialOf(materials, 'lane-geometry')?.lanes ?? [];
}

export function statusTag(status: string) {
  const labels: Record<string, string> = {
    ok: 'ok', candidate: 'candidate', invalid: 'invalid',
    'no-solution': 'no-solution', 'budget-exhausted': 'budget-exhausted',
    'corrupt-format': 'corrupt-format',
  };
  return labels[status] ?? status;
}
