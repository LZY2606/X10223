export interface CasePackLadderRow {
  row: number;
  token: string;
  mass: number | null;
}
export interface CasePackGel {
  file: string;
  sha256: string;
  width: number;
  height: number;
  title: string;
  exposure: { exposureS: number | null; gain: number | null; saturationLevel: number | null };
  orientation: { rotation90: 0 | 1 | 2 | 3; flipH: boolean; flipV: boolean };
  nominalOverrides: Record<string, number> | null;
  dropNominalRows: number[];
  lanes: { laneIndex: number; role: 'ladder' | 'sample'; label: string; width: number; center: { x: number; y: number }[] }[];
  bands: { laneIndex: number; x: number; y: number; fwhm: number; saturated: boolean; smeared: boolean; overlap: boolean; nominalRow: number | null }[];
}
export interface RotatedGelCase {
  id: string;
  name: string;
  version: string;
  domain: string;
  unitBasis: { mass: string; migration: string; time: string; coordinateFrame: string };
  ladderTable: CasePackLadderRow[];
  gels: Record<string, CasePackGel>;
  scenarios: { id: string; gel: string; title: string; rule: string; impact: { include: string[]; exclude: string[] } }[];
}
