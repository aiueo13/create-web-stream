import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReadableStream } from '../dist/index.js'

async function readAll(stream) {
  const reader = stream.getReader()
  const chunks = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return chunks
}

for (const v of [[true, 'byteStream'], [false, 'defaultStream']]) {
  const __internal_useByteStream__ = v[0]
  const name = v[1]
  const opts = () => ({ __internal_useByteStream__ })

  test(name + ': basic read sequence', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ]
    let i = 0
    const stream = createReadableStream({
      read() {
        if (i >= chunks.length) return null
        return chunks[i++]
      },
    }, opts())
    const result = await readAll(stream)
    assert.equal(result.length, 3)
    assert.deepEqual(result[0], new Uint8Array([1, 2, 3]))
    assert.deepEqual(result[1], new Uint8Array([4, 5]))
    assert.deepEqual(result[2], new Uint8Array([6, 7, 8, 9]))
  })

  test(name + ': empty read ends stream', async () => {
    let callCount = 0
    const stream = createReadableStream({
      read() {
        callCount++
        if (callCount === 1) return new Uint8Array([42])
        return new Uint8Array(0)
      },
    }, opts())
    const result = await readAll(stream)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0], new Uint8Array([42]))
  })

  test(name + ': null ends stream', async () => {
    let callCount = 0
    const stream = createReadableStream({
      read() {
        callCount++
        if (callCount === 1) return new Uint8Array([1])
        return null
      },
    }, opts())
    const result = await readAll(stream)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0], new Uint8Array([1]))
  })

  test(name + ': undefined ends stream', async () => {
    let callCount = 0
    const stream = createReadableStream({
      read() {
        callCount++
        if (callCount === 1) return new Uint8Array([1])
        return undefined
      },
    }, opts())
    const result = await readAll(stream)
    assert.equal(result.length, 1)
  })

  test(name + ': release called with Close when stream ends', async () => {
    const released = []
    const stream = createReadableStream({
      read() {
        return null
      },
      release(type, reason) {
        released.push({ type, reason })
      },
    }, opts())
    await readAll(stream)
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Close')
  })

  test(name + ': release called with Cancel when reader.cancel()', async () => {
    const released = []
    const stream = createReadableStream({
      read() {
        return new Uint8Array([1])
      },
      release(type, reason) {
        released.push({ type, reason })
      },
    }, opts())
    const reader = stream.getReader()
    await reader.cancel('cancel-reason')
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Cancel')
    assert.equal(released[0].reason, 'cancel-reason')
  })

  test(name + ': release called with SignalAbort when signal aborts', async () => {
    const released = []
    const ac = new AbortController()
    const stream = createReadableStream({
      read() {
        return new Uint8Array([1])
      },
      release(type, reason) {
        released.push({ type, reason })
      },
    }, { ...opts(), signal: ac.signal })
    const reader = stream.getReader()
    const readPromise = reader.read()
    ac.abort()
    await assert.rejects(() => readPromise, { name: 'AbortError' })
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'SignalAbort')
  })

  test(name + ': release called with Error when read throws', async () => {
    const released = []
    const stream = createReadableStream({
      read() {
        throw new Error('read-error')
      },
      release(type, reason) {
        released.push({ type, reason })
      },
    }, opts())
    const reader = stream.getReader()
    await assert.rejects(() => reader.read(), { message: 'read-error' })
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Error')
    assert.equal(released[0].reason?.message, 'read-error')
  })

  test(name + ': async read', async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2])]
    let i = 0
    const stream = createReadableStream({
      async read() {
        if (i >= chunks.length) return null
        return chunks[i++]
      },
    }, opts())
    const result = await readAll(stream)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], new Uint8Array([1]))
    assert.deepEqual(result[1], new Uint8Array([2]))
  })
}

test('byteStream: getReader({ mode: "byob" }) reads chunks', async () => {
  let called = 0
  const stream = createReadableStream({
    read() {
      called++
      if (called === 1) return new Uint8Array([1, 2, 3, 4, 5])
      return null
    },
  }, { __internal_useByteStream__: true })
  const reader = stream.getReader({ mode: 'byob' })
  const buf = new Uint8Array(3)
  const { value: v1, done: d1 } = await reader.read(buf)
  assert.equal(d1, false)
  assert.equal(v1?.byteLength, 3)
  assert.deepEqual(new Uint8Array(v1?.buffer ?? []).subarray(v1?.byteOffset ?? 0, (v1?.byteOffset ?? 0) + (v1?.byteLength ?? 0)), new Uint8Array([1, 2, 3]))
  const buf2 = new Uint8Array(4)
  const { value: v2, done: d2 } = await reader.read(buf2)
  assert.equal(d2, false)
  assert.equal(v2?.byteLength, 2)
  const view2 = v2 instanceof Uint8Array ? v2 : new Uint8Array(v2?.buffer ?? [], v2?.byteOffset ?? 0, v2?.byteLength ?? 0)
  assert.deepEqual(view2, new Uint8Array([4, 5]))
  const { value: v3, done: d3 } = await reader.read(new Uint8Array(1))
  assert.equal(d3, true)
  assert.ok(v3 === undefined || (v3 && v3.byteLength === 0), 'value when done is undefined or empty')
  reader.releaseLock()
})