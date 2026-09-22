export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('api error'), { status: res.status, body });
  return body as T;
}

export interface ApiBranchView {
  branch: { id: string; name: string; purpose: string; headEventId: string | null; forkedFromEventId: string | null };
  events: Array<{
    id: string; seq: number; type: string; parentId: string | null;
    payload: Record<string, any>; creator: string; createdAt: string;
  }>;
  compute: ApiCompute;
}

export interface ApiCompute {
  nodes: Array<{ id: string; kind: string; subjectId: string; status: string; paramsVersion: string; inputsDigest: string; dependencies: string[]; diagnostics: any[] }>;
  diagnostics: any[];
  calibration: any;
  bandResults: any[];
  rotatedSize: { width: number; height: number };
  laneViewPoints: Record<string, { x: number; y: number }[]>;
  profiles: Record<string, Array<{ s: number; intensity: number; saturated: boolean }>>;
  peaks: Record<string, any[]>;
  paramsVersion: string;
  imageSha256: string;
}
