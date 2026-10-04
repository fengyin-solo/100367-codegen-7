// 极简 ZIP 打包：仅 stored（不压缩）条目，够台账打包下载用，不引第三方依赖。
const encoder = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(now: Date): { date: number; time: number } {
  const year = Math.max(now.getFullYear(), 1980)
  return {
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
  }
}

export type ZipEntry = { name: string; content: string }

export function zipFiles(entries: ZipEntry[]): Blob {
  const { date, time } = dosDateTime(new Date())
  const prepared = entries.map((entry) => ({
    name: encoder.encode(entry.name),
    body: encoder.encode(entry.content),
  }))
  // 每条目：本地头 30 + 中央目录 46 + 文件名 ×2 + 内容；结尾记录 22。
  const total =
    prepared.reduce((sum, item) => sum + 30 + 46 + item.name.length * 2 + item.body.length, 0) + 22
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let offset = 0
  const central: { name: Uint8Array; body: Uint8Array; crc: number; at: number }[] = []

  for (const item of prepared) {
    const crc = crc32(item.body)
    const at = offset
    view.setUint32(offset, 0x04034b50, true)
    view.setUint16(offset + 4, 20, true) // 解压所需版本
    view.setUint16(offset + 6, 0x0800, true) // UTF-8 文件名
    view.setUint16(offset + 8, 0, true) // stored
    view.setUint16(offset + 10, time, true)
    view.setUint16(offset + 12, date, true)
    view.setUint32(offset + 14, crc, true)
    view.setUint32(offset + 18, item.body.length, true)
    view.setUint32(offset + 22, item.body.length, true)
    view.setUint16(offset + 26, item.name.length, true)
    view.setUint16(offset + 28, 0, true)
    offset += 30
    out.set(item.name, offset)
    offset += item.name.length
    out.set(item.body, offset)
    offset += item.body.length
    central.push({ name: item.name, body: item.body, crc, at })
  }

  const centralStart = offset
  for (const item of central) {
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 20, true)
    view.setUint16(offset + 8, 0x0800, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint16(offset + 12, time, true)
    view.setUint16(offset + 14, date, true)
    view.setUint32(offset + 16, item.crc, true)
    view.setUint32(offset + 20, item.body.length, true)
    view.setUint32(offset + 24, item.body.length, true)
    view.setUint16(offset + 28, item.name.length, true)
    view.setUint32(offset + 42, item.at, true)
    offset += 46
    out.set(item.name, offset)
    offset += item.name.length
  }
  const centralSize = offset - centralStart

  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, central.length, true)
  view.setUint16(offset + 10, central.length, true)
  view.setUint32(offset + 12, centralSize, true)
  view.setUint32(offset + 16, centralStart, true)

  return new Blob([out.buffer], { type: 'application/zip' })
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
