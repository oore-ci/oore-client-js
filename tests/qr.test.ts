import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { encodeQr, renderQr } from '../src/cli/qr.js'

const fingerprint = (matrix: ReadonlyArray<ReadonlyArray<boolean>>) =>
  createHash('sha256')
    .update(matrix.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join('\n'))
    .digest('hex')

// Both codes were decoded back to their text with jsQR when these were taken.
test('encodes byte-mode QR codes at level M', () => {
  const short = encodeQr('https://ci.test/install/abc')
  const long = encodeQr('x'.repeat(200))

  expect(short).toHaveLength(29) // version 3
  expect(long).toHaveLength(57) // version 10, with version information
  expect(fingerprint(short)).toBe(
    'ff2d628636b7bb0f5f4ac6a5c5decbf2b11f2dbcf19017daceed80311647b024',
  )
  expect(fingerprint(long)).toBe(
    '64e9db0f7dcfa486be63739a1efef2c8324387cf233f7686c75d9b4e079a8873',
  )
})

test('draws finder patterns in three corners', () => {
  const matrix = encodeQr('a')
  const size = matrix.length
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
  for (const [x, y] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    const rows = finder.map((_, dy) =>
      matrix[y + dy]!.slice(x, x + 7).map((dark) => (dark ? '1' : '0')).join(''),
    )
    expect(rows).toEqual(finder)
  }
})

test('rejects text that does not fit in version 40', () => {
  expect(() => encodeQr('x'.repeat(2400))).toThrow('too long')
})

test('renders two module rows per line inside a quiet zone', () => {
  const matrix = encodeQr('a')
  const plain = renderQr(matrix).split('\n')
  expect(plain).toHaveLength(Math.ceil((matrix.length + 8) / 2))
  expect(plain.every((line) => [...line].length === matrix.length + 8)).toBe(true)
  expect(plain[0]!.trim()).toBe('')

  const colored = renderQr(matrix, { color: true }).split('\n')
  expect(colored.every((line) => line.startsWith('\x1b[30;107m') && line.endsWith('\x1b[0m'))).toBe(true)
})
