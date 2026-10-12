import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeVariant,
  encodeVariant,
  frameMessage,
  GdFloat,
  GdVector2i,
  MessageReader,
  type GdValue
} from '../src/main/services/godot-wire'

test('Godot variants round-trip common nested values and packed bytes', () => {
  const encoded = encodeVariant([
    null,
    true,
    false,
    42,
    3.5,
    'Genie 🎮',
    new GdFloat(1.25),
    new GdVector2i(7, -4),
    new Uint8Array([0, 127, 255]),
    new Map<GdValue, GdValue>([
      ['ready', true],
      ['score', 12n]
    ])
  ])

  assert.deepEqual(decodeVariant(encoded), [
    null,
    true,
    false,
    42,
    3.5,
    'Genie 🎮',
    1.25,
    [7, -4],
    new Uint8Array([0, 127, 255]),
    { ready: true, score: 12 }
  ])
})

test('Godot variants preserve integers outside JavaScript safe range', () => {
  const value = 9_007_199_254_740_993n
  assert.equal(decodeVariant(encodeVariant(value)), value)
})

test('debugger message reader buffers partial frames and reads concatenated frames', () => {
  const first = frameMessage('scene_tree', 12, ['root'])
  const second = frameMessage('state', 13n, [new GdVector2i(2, 5)])
  const reader = new MessageReader()

  assert.deepEqual(reader.push(first.subarray(0, 3)), [])
  assert.deepEqual(reader.push(first.subarray(3, first.length - 2)), [])
  assert.deepEqual(
    reader.push(Buffer.concat([first.subarray(first.length - 2), second])),
    [
      { name: 'scene_tree', threadId: 12, data: ['root'] },
      { name: 'state', threadId: 13, data: [[2, 5]] }
    ]
  )
})

test('debugger message reader skips malformed payloads and remains aligned', () => {
  const malformed = Buffer.alloc(8)
  malformed.writeUInt32LE(4, 0)
  malformed.writeUInt32LE(255, 4)
  const valid = frameMessage('log', 1, ['still connected'])
  const reader = new MessageReader()

  assert.deepEqual(reader.push(Buffer.concat([malformed, valid])), [
    { name: 'log', threadId: 1, data: ['still connected'] }
  ])
})
