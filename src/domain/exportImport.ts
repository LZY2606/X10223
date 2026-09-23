import type { Result } from "./diagnostics.ts";
import { ok, fail, diag } from "./diagnostics.ts";
import type { Material, Derived, EventRecord, Branch } from "./model.ts";
import { digestOfProject } from "./model.ts";

export const BUNDLE_FORMAT = "gel-ruler-bundle/1";

export interface Bundle {
  format: string;
  exportedAt: string;
  project: string;
  digest: string;
  branches: Branch[];
  materials: Material[];
  derived: Derived[];
  events: EventRecord[];
}

export function exportBundle(project: string, branches: Branch[], materials: Material[], derived: Derived[], events: EventRecord[]): Bundle {
  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    project,
    digest: digestOfProject(materials, derived, events),
    branches, materials, derived,
    events: [...events].sort((a, b) => a.seq - b.seq),
  };
}

/** Validate a parsed bundle. Bad JSON or schema -> format_corrupt with position. */
export function validateBundle(raw: string): Result<Bundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail("format_corrupt", [diag("bundle-not-json", `invalid JSON: ${(e as Error).message}`, "/")]);
  }
  const b = parsed as Partial<Bundle>;
  if (b.format !== BUNDLE_FORMAT) return fail("format_corrupt", [diag("bundle-format", `expected ${BUNDLE_FORMAT}`, "/format")]);
  for (const key of ["materials", "derived", "events", "branches"] as const) {
    if (!Array.isArray(b[key])) return fail("format_corrupt", [diag("bundle-section-missing", `missing array section ${key}`, `/${key}`)]);
  }
  for (let i = 0; i < b.events!.length; i++) {
    const e = b.events![i];
    if (typeof e.id !== "string" || typeof e.seq !== "number") {
      return fail("format_corrupt", [diag("bundle-event-invalid", "event lacks id/seq", `/events/${i}`)]);
    }
  }
  return ok(b as Bundle);
}
