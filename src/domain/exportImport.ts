import { digest } from './ids';
import { fail, ok, type Outcome } from './result';

export interface BundleTables {
  materials: unknown[];
  events: unknown[];
  estimates: unknown[];
  archive: unknown[];
}

export interface Bundle extends BundleTables {
  format: 'gel-ruler-bundle';
  version: 1;
  digest: string;
}

export function buildBundle(tables: BundleTables): Buffer {
  const body: BundleTables = {
    materials: tables.materials,
    events: tables.events,
    estimates: tables.estimates,
    archive: tables.archive,
  };
  const bundle: Bundle = { format: 'gel-ruler-bundle', version: 1, ...body, digest: digest(body) };
  return Buffer.from(JSON.stringify(bundle, null, 1), 'utf8');
}

export function parseBundle(bytes: Buffer): Outcome<Bundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return fail('FormatCorrupt', `bundle is not valid JSON: ${(e as Error).message}`);
  }
  const b = parsed as Partial<Bundle>;
  if (b?.format !== 'gel-ruler-bundle' || b.version !== 1) {
    return fail('FormatCorrupt', 'bundle format/version mismatch');
  }
  for (const key of ['materials', 'events', 'estimates', 'archive'] as const) {
    if (!Array.isArray(b[key])) return fail('FormatCorrupt', `bundle missing array "${key}"`);
  }
  const body: BundleTables = {
    materials: b.materials!,
    events: b.events!,
    estimates: b.estimates!,
    archive: b.archive!,
  };
  if (digest(body) !== b.digest) {
    return fail('FormatCorrupt', 'bundle digest mismatch: content corrupted or truncated');
  }
  for (const key of ['materials', 'events', 'estimates'] as const) {
    const rows = b[key] as { seq?: number }[];
    for (let i = 1; i < rows.length; i++) {
      if (
        typeof rows[i].seq === 'number' &&
        typeof rows[i - 1].seq === 'number' &&
        (rows[i].seq as number) < (rows[i - 1].seq as number)
      ) {
        return fail('FormatCorrupt', `bundle table "${key}" is not in stable seq order`);
      }
    }
  }
  return ok(b as Bundle);
}
