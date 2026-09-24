export interface RawImage {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Buffer; // RGB 或 RGBA，逐行紧凑
}

export interface OrientedImage extends RawImage {
  rotationCw: 0 | 90 | 180 | 270;
  flipH: boolean;
  parentSha256: string;
}
