// 离线案例包图像资产：渲染 8 张领域凝胶 PNG（基线 + 7 种边界情形）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../../shared/hash.js';
import { stableId } from '../../shared/ids.js';
import { encodeGrayPng, type GrayImage } from '../image/png.js';
import { renderGel, rotateGray, type GelRenderResult } from '../image/render.js';

export interface RenderedAsset {
  key: string;
  filename: string;
  bytes: Uint8Array;
  image: GrayImage;
  truth: GelRenderResult;
  sha256: string;
  materialId: string;
  orientationDegrees: number;
  exposureDurationS: number;
}

const PROJECT = 'proj_gel_case_0001';

export function renderAllAssets(outDir?: string): RenderedAsset[] {
  const make = (
    key: string,
    render: () => GelRenderResult,
    opts: { rotate?: number; exposure?: number } = {},
  ): RenderedAsset => {
    const truth = render();
    const deg = opts.rotate ?? 0;
    const rot = rotateGray(truth.gray, truth.width, truth.height, deg);
    const bytes = encodeGrayPng(rot.width, rot.height, rot.gray);
    const filename = `${key}.png`;
    const sha256 = sha256Hex(bytes);
    const materialId = stableId('img', PROJECT, key);
    const image: GrayImage = { width: rot.width, height: rot.height, gray: rot.gray, rgba: truth.rgba };
    const asset: RenderedAsset = {
      key,
      filename,
      bytes,
      image,
      truth,
      sha256,
      materialId,
      orientationDegrees: deg,
      exposureDurationS: opts.exposure ?? 0.5,
    };
    if (outDir) {
      mkdirSync(dirname(join(outDir, filename)), { recursive: true });
      writeFileSync(join(outDir, filename), bytes);
    }
    return asset;
  };

  return [
    make('baseline', () => renderGel({ seed: 1 })),
    make('rotated', () => renderGel({ seed: 1 }), { rotate: 90 }),
    make('curved', () => renderGel({ seed: 1, smileAmpPx: 14, laneMeanderPx: 10 })),
    make('missing', () => renderGel({ seed: 1, missingLadderRank: 7 })),
    make('saturated', () => renderGel({ seed: 1, saturation: true, intensityScale: 1.35, backgroundGray: 232 })),
    make('overlap', () =>
      renderGel({ seed: 1, overlap: { laneIndex: 4, atFraction: 0.58, gapPx: 7 } })),
    make('nonmono', () => renderGel({ seed: 1 })),
    make('localfail', () => renderGel({ seed: 1, smileAmpPx: 8, laneMeanderPx: 6 })),
  ];
}
