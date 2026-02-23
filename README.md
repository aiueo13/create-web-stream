Note: **I’m using a translation tool, so there may be some inappropriate expressions.**

# create-web-stream

A library for creating Web API `ReadableStream` and `WritableStream` instances from simple handlers and options. Supports BYOB readers, buffered writers, `AbortSignal` integration, and guaranteed cleanup callbacks.

## Installation

```bash
npm install create-web-stream
# or
pnpm add create-web-stream
# or
yarn add create-web-stream
```

## Usage

### createReadableStream

Creates a `ReadableStream` that yields byte data from the handler's `read` callback. Use `release` for cleanup when the stream ends.

```ts
import { createReadableStream } from "create-web-stream"

const stream = createReadableStream({
  read() {
    // Return the next chunk. Return null, undefined, or empty Uint8Array to end the stream
    return new Uint8Array([1, 2, 3])
  },
  release(type, reason) {
    console.log("end:", type, reason)
  },
}, { signal: myAbortSignal })
```

### createBYOBReadableStream

Creates a BYOB-style `ReadableStream` that reads directly into a buffer provided by the consumer. `read(buffer)` returns the number of bytes written.

```ts
import { createBYOBReadableStream } from "create-web-stream"

const stream = createBYOBReadableStream(
  {
    read(buffer) {
      // Write into buffer and return the number of bytes written. Return 0 to end the stream
      buffer.set(new Uint8Array([1, 2, 3]), 0)
      return 3
    },
    release(type, reason) {
      console.log("end:", type, reason)
    },
  },
  4096, // bufferSize for fallback
  { signal: myAbortSignal }
)
```

### createWritableStream

Creates a `WritableStream` that passes byte data to the handler's `write` callback.

```ts
import { createWritableStream } from "create-web-stream"

const stream = createWritableStream(
  {
    write(chunk) {
      console.log("write:", chunk.byteLength, "bytes")
    },
    release(type, reason) {
      console.log("end:", type, reason)
    },
  },
  {
    signal: myAbortSignal,
    bufferSize: 4096,        // 0 for no buffering (default)
    strictBufferSize: false, // true to always pass chunks of exactly bufferSize (except the last)
    useBufferView: false,    // true to pass a buffer view to write and reduce copies
  }
)
```

## License

This project is licensed under either of:

- MIT License
- Apache License (Version 2.0)

at your option.
