export interface ProjectView {
  projectId: string;
  name: string;
  createdAt: string;
  branchId: string;
  branchOrder: string[];
  image: {
    materialId: string;
    width: number;
    height: number;
    orientation: { declared: string; source: string };
    exposure: { raw: string; normalized: { seconds: number | null }; metadata: Record<string, string> };
    origin: { filename: string; importedAt: string; sha256: string };
  } | null;
  ladder: {
    materialId: string;
    kitName: string;
    nominals: { nominalId: string; quantity: { raw: string; bp: number | null; unit: string } }[];
  };
  lanes: any[];
  bands: any[];
  analysis: {
    snapshotId: string;
    producerEventId: string;
    adopted: Record<string, string | undefined>;
    result: {
      fits: any[];
      inferences: any[];
      diagnostics: any[];
      profiles: { laneId: string; s: number; intensity: number }[][];
      ok: boolean;
    };
  } | null;
  adopted: Record<string, string | undefined>;
  decisions: any[];
  conflicts: any[];
  paramVersion: string;
  events: {
    eventId: string;
    seq: number;
    branchId: string;
    type: string;
    timestamp: string;
    paramVersion: string;
    parents: string[];
    selfHash: string;
    payloadSummary: Record<string, unknown>;
  }[];
}
