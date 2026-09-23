// 同步、确定性 SHA-256：业务规则在服务端与测试中可直接调用，不依赖浏览器 crypto。
// 纯 TS 实现（FIPS 180-4），输入字节 -> 16 进制摘要。

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed6aa82,
  0x4b3d6b8b, 0x5c82e59c, 0x654a32d9, 0x71b3fce8, 0x7cc8d6d9, 0x822e8ff7,
  0x90bfff82, 0x9d4cc0e3, 0xa98c0d2b, 0xabf57d51, 0xb69cdae3, 0xc84e9c87,
  0xd3b3b6d5, 0xe8a3c6d1, 0xf14c9d47, 0x299a7d33
]);

export function sha256Bytes(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLen = bytes.length * 8;
  const withPad = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(withPad);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  // 长度 64-bit big-endian（我们的输入远小于 2^32 字节）
  dv.setUint32(withPad - 4, bitLen >>> 0);
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000));

  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < withPad; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(chunk + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 =
        rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}

const encoder = new TextEncoder();

export function sha256Text(text: string): string {
  return sha256Bytes(encoder.encode(text));
}

/** 规范化 JSON：键排序、无空白，保证等价输入得到等价哈希/顺序 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k]))
      .join(',') +
    '}'
  );
}

export function contentHash(type: string, payload: unknown, parents: string[]): string {
  return sha256Text(canonicalJSON({ type, payload, parents }));
}

export function shortId(hash: string): string {
  return hash.slice(0, 12);
}
