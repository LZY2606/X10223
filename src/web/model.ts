export interface PointXY { x: number; y: number }
export interface Quantity { value: number; unit: string; raw?: string }
export interface Diagnostic { code: string; severity: 'error'|'warning'|'info'; message: string; at?: PointXY & { laneId?: string; field?: string }; fragment?: string }

export interface InputDigest {
  deps: { ref: string; sha: string }[]
  paramsVersion: string
  params: Record<string, unknown>
}
export interface LaneBoundary { laneId: string; label: string; isLadder?: boolean; spine: PointXY[]; halfWidth: number }
export interface BandObservation {
  bandId: string; laneId: string; at: PointXY; s: number; peak: number
  saturated: boolean; saturatedFraction: number; smear: boolean
  overlapWith: { bandId: string; fraction: number }[]
  profile: { s: number; v: number }[]
  source: 'auto'|'manual'; diagnostics: Diagnostic[]
}
export interface CalibrationPoint { ladderBandId: string; slot: number; s: number; nominal: Quantity; declaredMissing: boolean; used: boolean; residualLog?: number; excludeReason?: string }
export interface CalibrationSegment { index: number; s0: number; s1: number; a: number; b: number; pointIds: [string, string] }
export interface DetectionArtifact { artifactId: string; kind: 'detection'; inputDigest: InputDigest; imageId: string; proposedLanes: LaneBoundary[]; observations: BandObservation[]; diagnostics: Diagnostic[]; budget: { pixels:number; budgetPixels:number; exhausted:boolean } }
export interface CalibrationArtifact { artifactId: string; kind: 'calibration'; inputDigest: InputDigest; ladderLaneId: string; points: CalibrationPoint[]; segments: CalibrationSegment[]; validS: [number, number]; basisS: string; unit: string; diagnostics: Diagnostic[]; status: 'ok'|'degraded'|'semantic_impasse' }
export interface MwInference { bandId: string; laneId: string; s: number; state: 'unique'|'candidates'|'interval'|'invalid'; unique?: Quantity; candidates?: Quantity[]; interval?: [Quantity, Quantity]; segmentIndex?: number; reasons: string[]; diagnostics: Diagnostic[] }
export interface MwArtifact { artifactId: string; kind: 'mw_inference'; inputDigest: InputDigest; inferences: MwInference[]; diagnostics: Diagnostic[] }
export type Artifact = DetectionArtifact | CalibrationArtifact | MwArtifact

export interface EventBase { eventId: string; projectId: string; branchId: string; seq: number; parentId: string | null; at: string; type: string }
export type AnyEvent = EventBase & Record<string, unknown>
