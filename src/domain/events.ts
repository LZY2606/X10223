import type {
  BandKind,
  Diagnostic,
  LaneRole,
  OrientationTag,
  ParamVersion,
  PixelPoint,
  WorkbenchParams
} from "./types.js";

export type EventType =
  | "project_created"
  | "image_imported"
  | "lanes_detected"
  | "lane_revised"
  | "ladder_declared"
  | "ladder_revised"
  | "bands_detected"
  | "band_revised"
  | "band_deleted"
  | "decision_made"
  | "params_revised"
  | "branch_created";

export interface ImageImportPayload {
  pngBase64: string;
  width: number;
  height: number;
  parentImageId: string | null;
  captureOrientation: {
    declared: OrientationTag;
    evidence: string;
    source: "auto" | "manual";
  };
  rotationDeg: number;
  exposureRaw: string;
  exposureUnit: string | null;
  maxSensorValue: number;
  capturedAt: string | null;
  timeBasis: string;
  note: string;
}

export interface LaneCurvePayload {
  ordinal: number;
  role: LaneRole;
  label: string;
  halfWidth: number;
  curve: PixelPoint[];
}

export interface LadderEntryPayload {
  id?: string;
  raw: string;
  orderFromTop: number;
}

export interface BandPayload {
  laneId: string;
  s: number;
  sLow?: number;
  sHigh?: number;
  bandKind?: BandKind;
  note?: string;
}

export type EventPayloadMap = {
  project_created: { name: string; caseId?: string };
  image_imported: ImageImportPayload;
  lanes_detected: {
    imageId: string;
    lanes: LaneCurvePayload[];
    diagnostics: Diagnostic[];
  };
  lane_revised: { imageId: string; laneId: string; curve: PixelPoint[] };
  ladder_declared: {
    laneId: string;
    name: string;
    entries: LadderEntryPayload[];
  };
  ladder_revised: {
    ladderId: string;
    entries: LadderEntryPayload[];
    name?: string;
  };
  bands_detected: {
    imageId: string;
    items: {
      laneId: string;
      ordinalInLane: number;
      s: number;
      sLow: number;
      sHigh: number;
      width: number;
      amplitude: number;
      peakValue: number;
      bandKind: BandKind;
      saturationRatio: number;
      tailLength: number;
      overlapsWithOrdinal: number | null;
      profile: { s: number; intensity: number; fit: number }[];
    }[];
    diagnostics: Diagnostic[];
  };
  band_revised: {
    imageId: string;
    bandId: string;
    s?: number;
    bandKind?: BandKind;
  };
  band_deleted: { imageId: string; bandId: string };
  decision_made: {
    targetType: "band" | "ladder" | "lane" | "ruler";
    targetId: string;
    verdict: "accepted" | "rejected";
    note: string;
    /** 与该决定冲突的既有决定（保留双方） */
    conflictsWith: string[];
    suggestedMw?: number;
  };
  params_revised: { values: WorkbenchParams; reason: string };
  branch_created: { name: string; fromEventId: string; note: string };
};

export type EventTypeWithPayload = keyof EventPayloadMap;

export interface WorkbenchEvent<T extends EventType = EventType> {
  id: string;
  seq: number;
  branch: string;
  type: T;
  payload: T extends EventTypeWithPayload ? EventPayloadMap[T] : unknown;
  parentEventId: string | null;
  createdAt: number;
  createdBy: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  caseId: string | null;
  createdAt: number;
  mainHead: string | null;
}

export interface BranchRecord {
  name: string;
  createdAt: number;
  createdEventId: string;
  fromEventId: string;
  headEventId: string;
  note: string;
}

export interface ProjectBundle {
  format: "gelwb.bundle";
  formatVersion: 1;
  project: ProjectMeta;
  params: ParamVersion[];
  branches: BranchRecord[];
  events: WorkbenchEvent[];
  exportedAt: number;
}
