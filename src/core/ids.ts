// Deterministic, dependency-free stable identities.
// FNV-1a 64-bit rendered as hex with a domain prefix.
// Equal inputs always produce equal ids; ids never depend on wall clock time.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  const bytes = Buffer.from(input, "utf8");
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash;
}

export function stableId(prefix: string, parts: ReadonlyArray<unknown>): string {
  const canonical = parts
    .map((part) => (typeof part === "string" ? part : canonicalJson(part)))
    .join("|");
  const hash = fnv1a64(canonical).toString(16).padStart(16, "0");
  return `${prefix}_${hash}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Content address for byte payloads. Isomorphic: works in Node and the browser.
// SHA-256 via web crypto when available, deterministic FNV-1a fallback otherwise.
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: Crypto["subtle"] } }).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    return "sha256:" + hex;
  }
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64;
  }
  return "fnv1a:" + hash.toString(16).padStart(16, "0");
}
