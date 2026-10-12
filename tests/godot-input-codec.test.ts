import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  domButtonToGodot,
  domButtonsToGodotMask,
  encodeKeyEvent,
  encodeMouseButtonEvent,
  keyEventToAgentPayload
} from '../src/main/services/godot-input-codec'

test('keyboard codec maps logical and physical keys with modifier flags', () => {
  const bytes = Buffer.from(
    encodeKeyEvent({
      key: 'a',
      code: 'KeyA',
      pressed: true,
      echo: true,
      location: 2,
      shift: true,
      ctrl: true,
      alt: false,
      meta: false
    })
  )

  assert.equal(bytes.length, 19)
  assert.equal(bytes.readUInt8(0), 0)
  assert.equal(bytes.readUInt8(1), 51) // Shift + Ctrl + Echo + Pressed
  assert.equal(bytes.readUInt32LE(2), 65) // Logical key A
  assert.equal(bytes.readUInt32LE(6), 65) // Physical KeyA
  assert.equal(bytes.readUInt32LE(10), 65) // Key label
  assert.equal(bytes.readUInt32LE(14), 97) // Typed lowercase character
  assert.equal(bytes.readUInt8(18), 2)
})

test('mouse button codec writes button, position, mask, and modifier flags', () => {
  const bytes = Buffer.from(
    encodeMouseButtonEvent({
      button: 1,
      pressed: true,
      doubleClick: true,
      x: 12.5,
      y: -3.25,
      mask: 1,
      shift: false,
      ctrl: true,
      alt: false,
      meta: false
    })
  )

  assert.equal(bytes.length, 12)
  assert.equal(bytes.readUInt8(0), 1)
  assert.equal(bytes.readUInt8(1), 98) // Ctrl + Pressed + Double click
  assert.equal(bytes.readUInt8(2), 1)
  assert.equal(bytes.readFloatLE(3), 12.5)
  assert.equal(bytes.readFloatLE(7), -3.25)
  assert.equal(bytes.readUInt8(11), 1)
})

test('DOM mouse button values map to Godot values and masks', () => {
  assert.deepEqual([0, 1, 2].map(domButtonToGodot), [1, 3, 2])
  assert.equal(domButtonsToGodotMask(0b111), 0b111)
})

test('windowed game input payload preserves key and modifier details', () => {
  assert.deepEqual(
    keyEventToAgentPayload({
      key: 'Escape',
      code: 'Escape',
      pressed: false,
      echo: false,
      location: 0,
      shift: false,
      ctrl: false,
      alt: true,
      meta: false
    }),
    {
      kind: 'key',
      keycode: 4_194_305,
      physical: 4_194_305,
      unicode: 0,
      pressed: false,
      echo: false,
      shift: false,
      ctrl: false,
      alt: true,
      meta: false
    }
  )
})
