export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonize(value));
}

export function canonize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canonize(v);
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
