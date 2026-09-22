import type {
  BandCenterMaterial,
  Diagnostic,
  ExposureMaterial,
  GelImageMaterial,
  LadderSpecMaterial,
  LaneGeometryMaterial,
  Material,
  OrientationMaterial,
  ProjectState,
} from './types.js';

/**
 * 输入完整性校验：返回“带位置”的诊断。
 * 不完整时调用方据此中止，绝不以空值/默认值伪装成功。
 */
export function checkInputs(
  state: ProjectState,
  rasterAvailable: (sha: string) => boolean,
): {
  image?: GelImageMaterial;
  orientation?: OrientationMaterial;
  exposure?: ExposureMaterial;
  lanes?: LaneGeometryMaterial;
  ladder?: LadderSpecMaterial;
  bands: Record<string, BandCenterMaterial>;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const selected = state.selected;
  const image = selected['gel-image']
    ? (state.materials[selected['gel-image']] as GelImageMaterial | undefined)
    : undefined;
  const orientation = selected['orientation']
    ? (state.materials[selected['orientation']] as OrientationMaterial | undefined)
    : undefined;
  const exposure = selected['exposure']
    ? (state.materials[selected['exposure']] as ExposureMaterial | undefined)
    : undefined;
  const lanes = selected['lane-boundaries']
    ? (state.materials[selected['lane-boundaries']] as LaneGeometryMaterial | undefined)
    : undefined;
  const ladder = selected['ladder-spec']
    ? (state.materials[selected['ladder-spec']] as LadderSpecMaterial | undefined)
    : undefined;

  if (!image) {
    diagnostics.push({ code: 'missing-image', severity: 'error', message: '缺少原始凝胶图像材料' });
  } else if (!rasterAvailable(image.pngSha256)) {
    diagnostics.push({
      code: 'missing-raster-bytes',
      severity: 'error',
      message: `图像 ${image.id} 的像素字节缺失（sha256=${image.pngSha256}），无法计算`,
      at: { path: 'materials.gel-image', materialId: image.id },
    });
  }
  if (!orientation) {
    diagnostics.push({
      code: 'missing-orientation',
      severity: 'error',
      message: '缺少拍摄方向材料，无法确定电泳方向',
    });
  } else if (![0, 90, 180, 270].includes(orientation.rotateClockwise.value)) {
    diagnostics.push({
      code: 'bad-orientation',
      severity: 'error',
      message: `拍摄方向旋转角必须是 0/90/180/270，收到 ${orientation.rotateClockwise.raw ?? orientation.rotateClockwise.value}`,
      at: { path: 'materials.orientation.rotateClockwise', materialId: orientation.id },
    });
  }
  if (!exposure) {
    diagnostics.push({
      code: 'missing-exposure',
      severity: 'error',
      message: '缺少曝光材料，无法判断饱和阈值',
    });
  }
  if (!lanes) {
    diagnostics.push({
      code: 'missing-lanes',
      severity: 'error',
      message: '缺少 lane 边界材料',
    });
  }
  if (!ladder) {
    diagnostics.push({
      code: 'missing-ladder',
      severity: 'error',
      message: '缺少 ladder 标称值材料',
    });
  }

  const bands: Record<string, BandCenterMaterial> = {};
  if (lanes && ladder) {
    const ladderLane = lanes.lanes.find((l) => l.laneId === ladder.ladderLaneId);
    if (!ladderLane) {
      diagnostics.push({
        code: 'ladder-lane-not-found',
        severity: 'error',
        message: `ladder 引用的 lane ${ladder.ladderLaneId} 不存在于边界材料`,
        at: { path: 'materials.ladder-spec.ladderLaneId', materialId: ladder.id },
      });
    }
    for (const lane of lanes.lanes) {
      const bcId = state.selectedBands[lane.laneId];
      const bc = bcId ? (state.materials[bcId] as BandCenterMaterial | undefined) : undefined;
      if (!bc) {
        diagnostics.push({
          code: 'missing-band-centers',
          severity: 'error',
          message: `lane ${lane.label}(${lane.laneId}) 缺少条带中心材料`,
          at: { path: `materials.band-centers[${lane.laneId}]` },
        });
      } else {
        bands[lane.laneId] = bc;
      }
    }
  }

  // 校验每个材料都带来源，且像素来源指向当前图。
  if (image) {
    for (const m of Object.values(state.materials) as Material[]) {
      if (!m.provenance || m.provenance.length === 0) {
        diagnostics.push({
          code: 'no-provenance',
          severity: 'error',
          message: `材料 ${m.id} 缺少来源，无法回溯`,
          at: { path: 'materials', materialId: m.id },
        });
      }
    }
  }

  return { image, orientation, exposure, lanes, ladder, bands, diagnostics };
}
