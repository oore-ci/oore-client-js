// A small QR Code encoder (byte mode, error correction level M) for printing
// install links in a terminal. It follows ISO/IEC 18004 and the structure of
// Project Nayuki's reference encoder, without a runtime dependency.

/** Error correction codewords per block, by version (index 0 unused). */
const ECC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28,
]
/** Error correction blocks, by version (index 0 unused). */
const ECC_BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
  18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]
/** Format bits for level M. */
const LEVEL_M_FORMAT_BITS = 0

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0

const rawDataModules = (version: number): number => {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

const dataCodewords = (version: number): number =>
  Math.floor(rawDataModules(version) / 8) -
  ECC_PER_BLOCK[version]! * ECC_BLOCKS[version]!

const gfMultiply = (x: number, y: number): number => {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

const rsDivisor = (degree: number): Array<number> => {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < degree) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

const rsRemainder = (
  data: ReadonlyArray<number>,
  divisor: ReadonlyArray<number>,
): Array<number> => {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor)
    })
  }
  return result
}

const alignmentPositions = (version: number): Array<number> => {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step =
    Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
  const result = [6]
  for (let pos = version * 4 + 10; result.length < count; pos -= step) {
    result.splice(1, 0, pos)
  }
  return result
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** Rows of modules; `true` is dark. */
export type QrMatrix = ReadonlyArray<ReadonlyArray<boolean>>

/** Encodes text as a QR Code at error correction level M. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let version = 1
  for (; ; version++) {
    if (version > 40) throw new Error('Text is too long for a QR Code')
    const countBits = version <= 9 ? 8 : 16
    if (bytes.length < 2 ** countBits &&
      4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break
  }

  // Data bits: byte mode, length, payload, terminator and padding.
  const bits: Array<number> = []
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(0b0100, 4)
  append(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) append(byte, 8)
  const capacity = dataCodewords(version) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    append(pad, 8)
  }
  const data: Array<number> = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))
  }

  // Split into blocks, add error correction, interleave.
  const blockCount = ECC_BLOCKS[version]!
  const eccLength = ECC_PER_BLOCK[version]!
  const rawCodewords = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blockCount - (rawCodewords % blockCount)
  const shortBlockLength = Math.floor(rawCodewords / blockCount)
  const divisor = rsDivisor(eccLength)
  const blocks: Array<Array<number>> = []
  for (let i = 0, k = 0; i < blockCount; i++) {
    const length = shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1)
    const block = data.slice(k, k + length)
    k += length
    const ecc = rsRemainder(block, divisor)
    if (i < shortBlocks) block.push(0)
    blocks.push([...block, ...ecc])
  }
  const codewords: Array<number> = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) {
        codewords.push(block[i]!)
      }
    })
  }

  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  )
  const reserved = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  )
  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark
    reserved[y]![x] = true
  }

  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) {
          setFunction(x, y, distance !== 2 && distance !== 4)
        }
      }
    }
  }
  const align = alignmentPositions(version)
  align.forEach((ax, i) => {
    align.forEach((ay, j) => {
      const last = align.length - 1
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        return
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    })
  })

  const drawFormat = (mask: number) => {
    const value = (LEVEL_M_FORMAT_BITS << 3) | mask
    let remainder = value
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    }
    const format = ((value << 10) | remainder) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(format, i))
    setFunction(8, 7, bit(format, 6))
    setFunction(8, 8, bit(format, 7))
    setFunction(7, 8, bit(format, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(format, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(format, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(format, i))
    setFunction(8, size - 8, true)
  }
  drawFormat(0)

  if (version >= 7) {
    let remainder = version
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    }
    const info = (version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(a, b, bit(info, i))
      setFunction(b, a, bit(info, i))
    }
  }

  // Zigzag placement of the codewords.
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (!reserved[y]![x] && index < codewords.length * 8) {
          modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7))
          index++
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    const invert = MASKS[mask]!
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!reserved[y]![x] && invert(x, y)) modules[y]![x] = !modules[y]![x]
      }
    }
  }

  let bestMask = 0
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const score = penalty(modules)
    if (score < bestPenalty) {
      bestMask = mask
      bestPenalty = score
    }
    applyMask(mask)
  }
  applyMask(bestMask)
  drawFormat(bestMask)
  return modules
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
]

/** The four penalty rules of ISO/IEC 18004 section 8.8.2. */
function penalty(modules: ReadonlyArray<ReadonlyArray<boolean>>): number {
  const size = modules.length
  const at = (x: number, y: number, vertical: boolean) =>
    vertical ? modules[x]![y]! : modules[y]![x]!
  let score = 0
  let dark = 0
  for (const vertical of [false, true]) {
    for (let y = 0; y < size; y++) {
      let run = 1
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, vertical) === at(x - 1, y, vertical)) {
          run++
          continue
        }
        if (run >= 5) score += run - 2
        run = 1
      }
      for (let x = 0; x + 11 <= size; x++) {
        for (const pattern of FINDER_LIKE) {
          if (pattern.every((value, i) => at(x + i, y, vertical) === value)) {
            score += 40
          }
        }
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = modules[y]![x]!
      if (value) dark++
      if (
        x + 1 < size &&
        y + 1 < size &&
        value === modules[y]![x + 1] &&
        value === modules[y + 1]![x] &&
        value === modules[y + 1]![x + 1]
      ) {
        score += 3
      }
    }
  }
  const total = size * size
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return score
}

/**
 * Renders a QR Code with half-block characters, two module rows per line,
 * inside a quiet zone. With `color`, it forces black on white so the code
 * scans on dark terminal themes too.
 */
export function renderQr(
  matrix: QrMatrix,
  options: { color?: boolean; margin?: number } = {},
): string {
  const margin = options.margin ?? 4
  const size = matrix.length
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && matrix[y]![x]!
  const lines: Array<string> = []
  for (let y = -margin; y < size + margin; y += 2) {
    let line = ''
    for (let x = -margin; x < size + margin; x++) {
      const top = dark(x, y)
      const bottom = dark(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(options.color ? `\x1b[30;107m${line}\x1b[0m` : line)
  }
  return lines.join('\n')
}
