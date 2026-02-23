Note: **I’m using a translation tool, so there may be some inappropriate expressions.**

# create-web-stream

A library for creating Web API `ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>` instances from simple handlers and options. Supports BYOB readers, buffered writers, `AbortSignal` integration, and guaranteed cleanup callbacks.

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

Creates a `ReadableStream` that yields byte data from the handler's `read` callback.

```ts
import { createReadableStream } from "create-web-stream"

const stream = createReadableStream(
  // Handler
  {
    async read() {
      // Return the next chunk. Return null, undefined, or empty Uint8Array to end the stream
      return new Uint8Array([1, 2, 3])
    },
    async release(type, reason) {
      // Clearnup
    },
  }, 
  // Options
  { signal: myAbortSignal } 
)
```

### createBYOBReadableStream

Creates a BYOB-style `ReadableStream` that reads directly into a buffer provided by the consumer.

```ts
import { createBYOBReadableStream } from "create-web-stream"

const stream = createBYOBReadableStream(
  // Handler
  {
    async read(buffer) {
      // Write into buffer and return the number of bytes written. Return 0 to end the stream
      buffer.set(new Uint8Array([1, 2, 3]), 0)
      return 3
    },
    async release(type, reason) {
      // Clearnup
    },
  },
  // bufferSize for fallback
  4096,
  // Options
  { signal: myAbortSignal }
)
```

### createWritableStream

Creates a `WritableStream` that passes byte data to the handler's `write` callback.

```ts
import { createWritableStream } from "create-web-stream"

const stream = createWritableStream(
  // Handler
  {
    async write(chunk) {
      console.log("write: ", chunk.byteLength, "bytes")
    },
    async release(type, reason) {
      // Clearnup
    },
  },
  // Options
  {
    signal: myAbortSignal,
    bufferSize: 0, // Unbuffered
    strictBufferSize: false,
    useBufferView: false,
  }
)
```

## License

This project is licensed under either of:

- MIT License
- Apache License (Version 2.0)

at your option.
