import { deflateSync, inflateSync } from 'node:zlib'
import { DomainFailure } from '../shared/types'

// 最小 PNG：灰度 8-bit，单 IDAT，无交错。仅用于本案例包，不追求通用解码器。

function crcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}
const TABLE = crcTable()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)))
  const len = data.length
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, len)
  out.set(typeBytes, 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export interface GrayImage {
  width: number
  height: number
  /** row-major，长度 width*height，值 0..255（0 黑）。 */
  data: Uint8Array
}

export function encodePng(img: GrayImage): Uint8Array {
  if (img.data.length !== img.width * img.height) {
    throw new DomainFailure('corrupt_format', 'PNG 像素数与尺寸不符', [
      { code: 'png_size_mismatch', severity: 'error', message: 'width*height != data.length' }
    ])
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, img.width)
  dv.setUint32(4, img.height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // 每行前置 filter byte 0
  const raw = new Uint8Array(img.height * (img.width + 1))
  for (let y = 0; y < img.height; y++) {
    raw.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1)
  }
  const idat = deflateSync(raw)
  return concat([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array([]))
  ])
}

export function decodePng(bytes: Uint8Array): GrayImage {
  let pos = 0
  const need = (n: number) => {
    if (pos + n > bytes.length) {
      throw new DomainFailure('corrupt_format', 'PNG 被截断', [
        { code: 'png_truncated', severity: 'error', message: `期望 ${n} 字节，仅剩 ${bytes.length - pos}` }
      ])
    }
  }
  need(8)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) {
      throw new DomainFailure('corrupt_format', 'PNG 签名错误', [
        { code: 'png_bad_signature', severity: 'error', message: '不是 PNG 文件', fragment: Array.from(bytes.slice(0, 8)).join(',') }
      ])
    }
  }
  pos = 8
  let width = 0
  let height = 0
  const idatParts: Uint8Array[] = []
  let sawIhdr = false
  while (pos < bytes.length) {
    need(8)
    const dv0 = new DataView(bytes.buffer, bytes.byteOffset + pos)
    const len = dv0.getUint32(0)
    const type = String.fromCharCode(...bytes.slice(pos + 4, pos + 8))
    pos += 8
    need(len + 4)
    const data = bytes.slice(pos, pos + len)
    const givenCrc = new DataView(bytes.buffer, bytes.byteOffset + pos + len).getUint32(0)
    if (crc32(bytes.slice(pos - 4, pos + len)) !== givenCrc) {
      throw new DomainFailure('corrupt_format', `PNG 块 ${type} CRC 校验失败`, [
        { code: 'png_bad_crc', severity: 'error', message: '文件内容损坏（CRC 不一致）' }
      ])
    }
    pos += len + 4
    if (type === 'IHDR') {
      if (len < 13) throw new DomainFailure('corrupt_format', 'IHDR 过短', [{ code: 'png_bad_ihdr', severity: 'error', message: 'IHDR < 13' }])
      const dv = new DataView(data.buffer, data.byteOffset)
      width = dv.getUint32(0)
      height = dv.getUint32(4)
      if (data[8] !== 8 || data[9] !== 0) {
        throw new DomainFailure(
          'corrupt_format',
          '仅支持 8-bit 灰度 PNG',
          [{ code: 'png_unsupported', severity: 'error', message: `bitDepth=${data[8]} colorType=${data[9]}` }]
        )
      }
      sawIhdr = true
    } else if (type === 'IDAT') idatParts.push(data)
    else if (type === 'IEND') break
  }
  if (!sawIhdr) {
    throw new DomainFailure('corrupt_format', '缺少 IHDR', [{ code: 'png_no_ihdr', severity: 'error', message: 'PNG 无 IHDR 块' }])
  }
  if (idatParts.length === 0) {
    throw new DomainFailure('corrupt_format', '缺少 IDAT', [{ code: 'png_no_idat', severity: 'error', message: 'PNG 无图像数据' }])
  }
  let inflated: Uint8Array
  try {
    inflated = new Uint8Array(inflateSync(concat(idatParts)))
  } catch {
    throw new DomainFailure('corrupt_format', 'IDAT 无法解压', [
      { code: 'png_bad_zlib', severity: 'error', message: '压缩流损坏' }
    ])
  }
  const stride = width + 1
  if (inflated.length !== height * stride) {
    throw new DomainFailure('corrupt_format', '解压后尺寸不符', [
      { code: 'png_bad_dimensions', severity: 'error', message: `解压 ${inflated.length} 字节，期望 ${height * stride}` }
    ])
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride]
    if (filter !== 0) {
      throw new DomainFailure('corrupt_format', '不支持的行过滤器', [
        { code: 'png_bad_filter', severity: 'error', message: `第 ${y} 行 filter=${filter}，仅支持 0`, at: { x: 0, y } }
      ])
    }
    out.set(inflated.subarray(y * stride + 1, (y + 1) * stride), y * width)
  }
  return { width, height, data: out }
}

/** 90 度倍数旋转。quarters=1 => 顺时针 90。 */
export function rotateQuarters(img: GrayImage, quarters: number): GrayImage & { rotationDeg: number } {
  const r = ((quarters % 4) + 4) % 4
  if (r === 0) return { ...img, rotationDeg: 0 }
  const swap = r % 2 === 1
  const w2 = swap ? img.height : img.width
  const h2 = swap ? img.width : img.height
  const out = new Uint8Array(w2 * h2)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let nx = x
      let ny = y
      if (r === 1) [nx, ny] = [img.height - 1 - y, x]
      else if (r === 2) [nx, ny] = [img.width - 1 - x, img.height - 1 - y]
      else [nx, ny] = [y, img.width - 1 - x]
      out[ny * w2 + nx] = img.data[y * img.width + x]
    }
  }
  return { width: w2, height: h2, data: out, rotationDeg: r * 90 }
}
