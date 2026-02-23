import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBYOBReadableStream } from '../dist/index.js'

const DEFAULT_BUFFER_SIZE = 16

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
    const data = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
    let i = 0
    const stream = createBYOBReadableStream(
      {
        read(buffer) {
          if (i >= data.length) return 0
          const chunk = data[i++]
          buffer.set(chunk)
          return chunk.byteLength
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const result = await readAll(stream)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], new Uint8Array([1, 2, 3]))
    assert.deepEqual(result[1], new Uint8Array([4, 5, 6]))
  })

  test(name + ': nread=0 ends stream', async () => {
    let callCount = 0
    const stream = createBYOBReadableStream(
      {
        read(buffer) {
          callCount++
          if (callCount === 1) {
            buffer[0] = 42
            return 1
          }
          return 0
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const result = await readAll(stream)
    assert.equal(result.length, 1)
    assert.equal(result[0][0], 42)
  })

  test(name + ': partial fill smaller than buffer', async () => {
    let called = 0
    const stream = createBYOBReadableStream(
      {
        read(buffer) {
          called++
          if (called === 1) {
            buffer[0] = 10
            buffer[1] = 20
            return 2
          }
          return 0
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const result = await readAll(stream)
    assert.equal(result.length, 1)
    assert.equal(result[0].byteLength, 2)
    assert.deepEqual(result[0].slice(0, 2), new Uint8Array([10, 20]))
  })

  test(name + ': release called with Close when stream ends', async () => {
    const released = []
    const stream = createBYOBReadableStream(
      {
        read() {
          return 0
        },
        release(type, reason) {
          released.push({ type, reason })
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    await readAll(stream)
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Close')
  })

  test(name + ': release called with Cancel when reader.cancel()', async () => {
    const released = []
    const stream = createBYOBReadableStream(
      {
        read(buffer) {
          buffer[0] = 1
          return 1
        },
        release(type, reason) {
          released.push({ type, reason })
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const reader = stream.getReader()
    await reader.cancel('cancel-reason')
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Cancel')
    assert.equal(released[0].reason, 'cancel-reason')
  })

  test(name + ': release called with SignalAbort when signal aborts', async () => {
    const released = []
    const ac = new AbortController()
    const stream = createBYOBReadableStream(
      {
        read(buffer) {
          buffer[0] = 1
          return 1
        },
        release(type, reason) {
          released.push({ type, reason })
        },
      },
      DEFAULT_BUFFER_SIZE,
      { ...opts(), signal: ac.signal },
    )
    const reader = stream.getReader()
    const readPromise = reader.read()
    ac.abort()
    await assert.rejects(() => readPromise, { name: 'AbortError' })
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'SignalAbort')
  })

  test(name + ': release called with Error when read throws', async () => {
    const released = []
    const stream = createBYOBReadableStream(
      {
        read() {
          throw new Error('read-error')
        },
        release(type, reason) {
          released.push({ type, reason })
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const reader = stream.getReader()
    await assert.rejects(() => reader.read(), { message: 'read-error' })
    assert.equal(released.length, 1)
    assert.equal(released[0].type, 'Error')
    assert.equal(released[0].reason?.message, 'read-error')
  })

  test(name + ': async read', async () => {
    const data = [new Uint8Array([1]), new Uint8Array([2])]
    let i = 0
    const stream = createBYOBReadableStream(
      {
        async read(buffer) {
          if (i >= data.length) return 0
          const chunk = data[i++]
          buffer.set(chunk)
          return chunk.byteLength
        },
      },
      DEFAULT_BUFFER_SIZE,
      opts(),
    )
    const result = await readAll(stream)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], new Uint8Array([1]))
    assert.deepEqual(result[1], new Uint8Array([2]))
  })
}

test('defaultBufferSize 0 throws RangeError', () => {
  assert.throws(
    () =>
      createBYOBReadableStream(
        { read() {
          return 0
        } },
        0,
      ),
    { name: 'RangeError' },
  )
})

test('defaultBufferSize negative throws RangeError', () => {
  assert.throws(
    () =>
      createBYOBReadableStream(
        { read() {
          return 0
        } },
        -1,
      ),
    { name: 'RangeError' },
  )
})

test('defaultBufferSize NaN throws TypeError', () => {
  assert.throws(
    () =>
      createBYOBReadableStream(
        { read() {
          return 0
        } },
        NaN,
      ),
    { name: 'TypeError' },
  )
})

test('read returning negative nread rejects', async () => {
  const stream = createBYOBReadableStream(
    {
      read() {
        return -1
      },
    },
    DEFAULT_BUFFER_SIZE,
  )
  const reader = stream.getReader()
  await assert.rejects(() => reader.read(), RangeError)
})

test('read returning nread > buffer.byteLength rejects', async () => {
  const stream = createBYOBReadableStream(
    {
      read(buffer) {
        return buffer.byteLength + 1
      },
    },
    DEFAULT_BUFFER_SIZE,
  )
  const reader = stream.getReader()
  await assert.rejects(() => reader.read(), RangeError)
})

test('byteStream: getReader({ mode: "byob" }) reads chunks', async () => {
  let remaining = new Uint8Array([1, 2, 3, 4, 5])
  const stream = createBYOBReadableStream(
    {
      read(buffer) {
        if (remaining.byteLength === 0) return 0
        const n = Math.min(remaining.byteLength, buffer.byteLength)
        buffer.set(remaining.subarray(0, n))
        remaining = remaining.subarray(n)
        return n
      },
    },
    DEFAULT_BUFFER_SIZE,
    { __internal_useByteStream__: true },
  )
  const reader = stream.getReader({ mode: 'byob' })
  const buf = new Uint8Array(3)
  const { value: v1, done: d1 } = await reader.read(buf)
  assert.equal(d1, false)
  assert.equal(v1?.byteLength, 3)
  const view1 = v1 instanceof Uint8Array ? v1 : new Uint8Array(v1?.buffer ?? [], v1?.byteOffset ?? 0, v1?.byteLength ?? 0)
  assert.deepEqual(view1, new Uint8Array([1, 2, 3]))
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
