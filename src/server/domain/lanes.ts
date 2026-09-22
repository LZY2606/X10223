// Lane geometry and "smile" curvature correction.
// Each lane has a curved datum centerline y = a*x^2 + b*x + c in image px.
// A local ruler is only meaningful in datum-corrected y space and carries an
// explicit validity region: the same image y in two lanes is NOT the same
// molecular weight when the gel smiles.
export interface LaneCurve {
  laneId: string;
  coeff: [number, number, number]; // a, b, c
  xRef: number; // reference x (lane center at annotation time)
}

export function curveY(curve: LaneCurve, x: number): number {
  const [a, b, c] = curve.coeff;
  return a * x * x + b * x + c;
}

// Convert an image-space y at (x, lane) into the ladder lane's datum space.
export function correctedY(laneCurve: LaneCurve, ladderCurve: LaneCurve, ladderXRef: number, x: number, y: number): number {
  return y - curveY(laneCurve, x) + curveY(ladderCurve, ladderXRef);
}

export interface LaneRecord {
  laneId: string;
  index: number;
  role: 'ladder' | 'sample';
  boundary: { x0: number; x1: number }; // image px
  curve: LaneCurve;
  pixelSource: PixelSource;
}

export interface PixelSource {
  imageId: string;
  imageSha256: string;
  region: { x: number; y: number; w: number; h: number };
  transform: string; // e.g. 'identity' or 'rotate90cw'
}
