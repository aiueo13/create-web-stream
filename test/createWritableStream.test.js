import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWritableStream } from '../dist/index.js'

test('basic write and close', async () => {
  const chunks = []
  const stream = createWritableStream({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.write(new Uint8Array([4, 5]))
  await writer.close()
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2, 3]))
  assert.deepEqual(chunks[1], new Uint8Array([4, 5]))
})

test('release called with Close', async () => {
  const released = []
  const stream = createWritableStream({
    write() {},
    release(type, reason) {
      released.push({ type, reason })
    },
  })
  const writer = stream.getWriter()
  await writer.close()
  assert.equal(released.length, 1)
  assert.equal(released[0].type, 'Close')
})

test('release called with Abort', async () => {
  const released = []
  const stream = createWritableStream({
    write() {},
    release(type, reason) {
      released.push({ type, reason })
    },
  })
  const writer = stream.getWriter()
  await writer.abort('abort-reason')
  assert.equal(released.length, 1)
  assert.equal(released[0].type, 'Abort')
  assert.equal(released[0].reason, 'abort-reason')
})

test('write throws → Error', async () => {
  const released = []
  const stream = createWritableStream({
    write() {
      throw new Error('write-error')
    },
    release(type, reason) {
      released.push({ type, reason })
    },
  })
  const writer = stream.getWriter()
  await assert.rejects(() => writer.write(new Uint8Array([1])), { message: 'write-error' })
  assert.equal(released.length, 1)
  assert.equal(released[0].type, 'Error')
  assert.equal(released[0].reason?.message, 'write-error')
})

test('AbortSignal triggers SignalAbort', async () => {
  const released = []
  const ac = new AbortController()
  const stream = createWritableStream(
    {
      write() {},
      release(type, reason) {
        released.push({ type, reason })
      },
    },
    { signal: ac.signal },
  )
  const writer = stream.getWriter()
  const writePromise = writer.write(new Uint8Array([1]))
  ac.abort()
  await assert.rejects(() => writePromise, { name: 'AbortError' })
  assert.equal(released.length, 1)
  assert.equal(released[0].type, 'SignalAbort')
})

test('release called at most once', async () => {
  const released = []
  const stream = createWritableStream({
    write() {},
    release(type) {
      released.push(type)
    },
  })
  const writer = stream.getWriter()
  await writer.close()
  await writer.closed
  assert.equal(released.length, 1)
  assert.equal(released[0], 'Close')
})

test('bufferSize=0 passes chunk directly', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    { bufferSize: 0 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2, 3]))
})

test('buffering aggregates small writes', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    { bufferSize: 4 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1]))
  await writer.write(new Uint8Array([2]))
  await writer.write(new Uint8Array([3, 4]))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2, 3, 4]))
})

test('strictBufferSize enforces chunk size', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    { bufferSize: 2, strictBufferSize: true },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2]))
  await writer.write(new Uint8Array([3]))
  await writer.close()
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2]))
  assert.deepEqual(chunks[1], new Uint8Array([3]))
})

test('non-strict large chunk bypasses buffer', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    { bufferSize: 2 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1]))
  await writer.write(new Uint8Array([2, 3, 4, 5]))
  await writer.close()
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0], new Uint8Array([1]))
  assert.deepEqual(chunks[1], new Uint8Array([2, 3, 4, 5]))
})

test('useBufferView passes subarray view when flushing partial buffer', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push({ chunk, isView: chunk.byteLength > 0 && chunk.byteOffset !== undefined })
      },
    },
    { bufferSize: 4, useBufferView: true },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2]))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0].chunk, new Uint8Array([1, 2]))
})

test('write after close rejects', async () => {
  const stream = createWritableStream({ write() {} })
  const writer = stream.getWriter()
  await writer.close()
  await assert.rejects(() => writer.write(new Uint8Array([1])), Error)
})

test('write after abort rejects', async () => {
  const stream = createWritableStream({ write() {} })
  const writer = stream.getWriter()
  await writer.abort()
  await assert.rejects(() => writer.write(new Uint8Array([1])))
})

test('async write works', async () => {
  const chunks = []
  const stream = createWritableStream({
    async write(chunk) {
      chunks.push(chunk)
    },
  })
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1]))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], new Uint8Array([1]))
})

test('async release awaited', async () => {
  let releaseDone = false
  const stream = createWritableStream({
    write() {},
    async release() {
      releaseDone = true
    },
  })
  const writer = stream.getWriter()
  await writer.close()
  await writer.closed
  assert.equal(releaseDone, true)
})

test('strictBufferSize splits single write larger than bufferSize', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(Array.from(chunk))
      },
    },
    { bufferSize: 2, strictBufferSize: true },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3, 4, 5]))
  await writer.close()
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0], [1, 2])
  assert.deepEqual(chunks[1], [3, 4])
  assert.deepEqual(chunks[2], [5])
})

test('release throwing does not prevent stream termination', async () => {
  const stream = createWritableStream({
    write() {},
    release() {
      throw new Error('release-error')
    },
  })
  const writer = stream.getWriter()
  await assert.rejects(() => writer.close(), { message: 'release-error' })
})

test('options omitted uses default unbuffered', async () => {
  const chunks = []
  const stream = createWritableStream({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2, 3]))
})

test('empty write with bufferSize 0 passes empty chunk to handler', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk)
      },
    },
    { bufferSize: 0 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array(0))
  await writer.close()
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].byteLength, 0)
})

test('close without any write does not call handler.write', async () => {
  let writeCalls = 0
  const stream = createWritableStream({
    write() {
      writeCalls++
    },
  })
  const writer = stream.getWriter()
  await writer.close()
  assert.equal(writeCalls, 0)
})

test('write returning promise is awaited', async () => {
  const order = []
  const stream = createWritableStream(
    {
      async write() {
        order.push('write')
        await Promise.resolve()
        order.push('writeDone')
      },
    },
    { bufferSize: 2 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1]))
  order.push('closeStarted')
  const closePromise = writer.close()
  await closePromise
  order.push('closeDone')
  assert.deepEqual(order, ['closeStarted', 'write', 'writeDone', 'closeDone'])
})

test('release returning rejected promise causes close to reject', async () => {
  const stream = createWritableStream({
    write() {},
    async release() {
      throw new Error('release-reject')
    },
  })
  const writer = stream.getWriter()
  await assert.rejects(() => writer.close(), { message: 'release-reject' })
})

test('bufferSize fractional throws TypeError', () => {
  assert.throws(
    () =>
      createWritableStream(
        { write() {} },
        { bufferSize: 1.5 },
      ),
    { name: 'TypeError' },
  )
})

test('bufferSize negative throws RangeError', () => {
  assert.throws(
    () =>
      createWritableStream(
        { write() {} },
        { bufferSize: -1 },
      ),
    { name: 'RangeError' },
  )
})

test('non-strict flushes buffered then passes large chunk directly', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk.byteLength)
      },
    },
    { bufferSize: 3 },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2]))
  await writer.write(new Uint8Array([3, 4, 5, 6]))
  await writer.close()
  assert.deepEqual(chunks, [2, 4])
})

test('abort with no reason calls release with undefined reason', async () => {
  const released = []
  const stream = createWritableStream({
    write() {},
    release(type, reason) {
      released.push({ type, reason })
    },
  })
  const writer = stream.getWriter()
  await writer.abort()
  assert.equal(released.length, 1)
  assert.equal(released[0].type, 'Abort')
  assert.equal(released[0].reason, undefined)
})

test('after write error close() rejects', async () => {
  const stream = createWritableStream({
    write() {
      throw new Error('write-error')
    },
  })
  const writer = stream.getWriter()
  await assert.rejects(() => writer.write(new Uint8Array([1])), { message: 'write-error' })
  await assert.rejects(() => writer.close(), Error)
})

test('strictBufferSize with bufferSize 1 yields one chunk per byte', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(chunk[0])
      },
    },
    { bufferSize: 1, strictBufferSize: true },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.close()
  assert.deepEqual(chunks, [1, 2, 3])
})

test('multiple full buffers then partial on close', async () => {
  const chunks = []
  const stream = createWritableStream(
    {
      write(chunk) {
        chunks.push(Array.from(chunk))
      },
    },
    { bufferSize: 2, strictBufferSize: true },
  )
  const writer = stream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3, 4, 5]))
  await writer.close()
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0], [1, 2])
  assert.deepEqual(chunks[1], [3, 4])
  assert.deepEqual(chunks[2], [5])
})
