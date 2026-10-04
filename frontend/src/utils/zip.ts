// 最小 ZIP 写入器：不压缩（stored），只为把多张清单打成一个包下载。
// 纯前端没有后端打包接口，这里按 ZIP 规范手写本地文件头 + 中央目录 + 结尾记录。

const encoder = new TextEncoder()

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable !== null) {
    return crcTable
  }
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export type ZipEntry = {
  name: string
  data: Uint8Array<ArrayBuffer>
  time?: Date
}

export function textEntry(name: string, text: string): ZipEntry {
  return { name, data: encoder.encode(text) }
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

export function createZip(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  const now = new Date()

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const { date, time } = dosDateTime(entry.time ?? now)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // 本地文件头签名
    local.setUint16(4, 20, true) // 解压所需版本
    local.setUint16(6, 0x0800, true) // 通用标志：bit11 表示文件名是 UTF-8
    local.setUint16(8, 0, true) // 压缩方式：0 = stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, entry.data.length, true) // 压缩后大小
    local.setUint32(22, entry.data.length, true) // 原始大小
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true) // 扩展字段长度
    chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data)

    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true) // 中央目录签名
    header.setUint16(4, 20, true) // 压缩所用版本
    header.setUint16(6, 20, true)
    header.setUint16(8, 0x0800, true)
    header.setUint16(10, 0, true)
    header.setUint16(12, time, true)
    header.setUint16(14, date, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, entry.data.length, true)
    header.setUint32(24, entry.data.length, true)
    header.setUint16(28, nameBytes.length, true)
    header.setUint32(42, offset, true) // 本地文件头偏移
    central.push(new Uint8Array(header.buffer), nameBytes)

    offset += 30 + nameBytes.length + entry.data.length
  }

  const centralStart = offset
  let centralSize = 0
  for (const part of central) {
    centralSize += part.length
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // 结尾记录签名
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, centralStart, true)

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  })
}
