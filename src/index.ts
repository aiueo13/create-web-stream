export type CreateReadableStreamHandlerSource = Uint8Array<ArrayBuffer> | null | undefined

export type CreateReadableStreamHandlerReleaseType = "Close" | "Cancel" | "SignalAbort" | "Error"

export type CreateReadableStreamHandler = {

	/**
	 * A callback invoked when the stream's consumer requests more data.
	 * 
	 * - **Yielding data**: Return a `Uint8Array` containing the next chunk of bytes.
	 * - **Ending the stream**: Return `null`, `undefined`, or an empty `Uint8Array` (`byteLength === 0`) to signal that no more data is available. This will automatically close the stream.
	 * - **Handling errors**: If an error is thrown inside this function, the stream will enter an error state and terminate.
	 */
	read: () => PromiseLike<CreateReadableStreamHandlerSource> | CreateReadableStreamHandlerSource,

	/**
	 * An optional callback for performing cleanup operations.
	 * 
	 * This function is guaranteed to be invoked at most once. 
	 * It is automatically triggered when the stream terminates under any of the following conditions:
	 * - The stream's reader is successfully read to the end. (type: `"Close"`)
	 * - The stream or its reader is explicitly canceled. (type: `"Cancel"`)
	 * - The provided `AbortSignal` fires an `abort` event. (type: `"SignalAbort"`)
	 * - An error occurs during a read operation. (type: `"Error"`)
	 */
	release?: (type: CreateReadableStreamHandlerReleaseType, reason?: unknown) => PromiseLike<void> | void,
}

export type CreateReadableStreamOptions = {

	/**
	 * An `AbortSignal` to abort the stream.
	 * 
	 * When the abort event is fired, the handler's `release` function will be called.
	 */
	signal?: AbortSignal
}

/**
 * Creates a `ReadableStream` that yields byte data using the provided custom handler.
 * 
 * This function does not throw errors. 
 * If you need to throw an error early when the provided `options.signal` is already aborted,
 * the caller must check and handle it manually.
 * The resulting stream includes a BYOB (Bring Your Own Buffer) reader if supported by the runtime.
 * 
 * @param handler The stream handler: `read`, `release`. See `CreateReadableStreamHandler` for details.
 * @param options Optional settings: `signal`. See `CreateReadableStreamOptions` for details.
 * @returns A `ReadableStream<Uint8Array<ArrayBuffer>>` configured with the provided handler and options.
 */
export function createReadableStream(
	handler: CreateReadableStreamHandler,
	options?: CreateReadableStreamOptions,
): ReadableStream<Uint8Array<ArrayBuffer>> {

	let abortListener: (() => void) | null = null
	let buffer: Uint8Array<ArrayBuffer> | null = null

	let cleanupPromise: Promise<void> | null = null
	function cleanup(
		type: CreateReadableStreamHandlerReleaseType,
		reason?: unknown
	): Promise<void> {

		if (cleanupPromise === null) {
			cleanupPromise = (async () => {
				buffer = null
				if (options?.signal != null && abortListener != null) {
					options.signal.removeEventListener("abort", abortListener)
					abortListener = null
				}
				if (handler.release != null) {
					await handler.release(type, reason)
				}
			})()
		}
		return cleanupPromise
	}

	if (!isReadableByteStreamAvailable()) {
		return new ReadableStream({

			start(controller) {
				if (options?.signal != null) {
					abortListener = () => {
						const reason = options?.signal?.reason ?? newAbortSignalDefaultError()
						cleanup("SignalAbort", reason).catch(() => { })
						controller.error(reason)
					}
					options?.signal?.addEventListener("abort", abortListener);
				}
			},

			async pull(controller) {
				try {
					throwIfAborted(options?.signal)
					const data = await handler.read()
					throwIfAborted(options?.signal)
					if (data == null || data.byteLength === 0) {
						await cleanup("Close")
						controller.close()
						return
					}

					controller.enqueue(data)
				}
				catch (e) {
					const isSignalAbort = isThrownByAbortSignal(e, options?.signal)
					await cleanup(isSignalAbort ? "SignalAbort" : "Error", e).catch(() => { })
					throw e
				}
			},

			async cancel(reason) {
				await cleanup("Cancel", reason)
			}
		})
	}

	// autoAllocateChunkSize を指定すると stream.getReader() でも byob が使われるようになるが、
	// この実装で byob を用いてもコピーが増えるだけで恩恵が少ないため指定しない。
	// また type: "bytes" で strategy を指定すると (正確には size を定義すると) エラーになる点にも注意。
	return new ReadableStream({
		type: "bytes",

		start(controller) {
			if (options?.signal) {
				abortListener = () => {
					const reason = options?.signal?.reason ?? newAbortSignalDefaultError()
					cleanup("SignalAbort", reason).catch(() => { })
					controller.error(reason)
				}
				options?.signal.addEventListener("abort", abortListener)
			}
		},

		async pull(controller) {
			try {
				throwIfAborted(options?.signal)
				if (buffer == null || buffer.byteLength === 0) {
					buffer = (await handler.read()) ?? null
					throwIfAborted(options?.signal)
				}
				if (buffer == null || buffer.byteLength === 0) {
					await cleanup("Close")

					// byobRequest がある場合、respond を呼ばないと promise　が解決されない。
					// controller.close() の後だと respond(0) を読んでもエラーにはならない。
					// https://github.com/whatwg/streams/issues/1170
					controller.close()
					controller.byobRequest?.respond(0)
					return
				}

				const byob = controller.byobRequest
				// byobRequest がある場合、respond を呼ばないと promise　が解決されないことに注意
				if (byob != null) {
					// respond する前なので null にならない
					const v = byob.view!!
					const view = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
					const nread = Math.min(buffer.byteLength, view.byteLength)

					view.set(buffer.subarray(0, nread))
					buffer = buffer.subarray(nread)

					throwIfAborted(options?.signal)
					byob.respond(nread)
				}
				else {
					throwIfAborted(options?.signal)
					controller.enqueue(buffer)
					buffer = null
				}
			}
			catch (e) {
				const isSignalAbort = isThrownByAbortSignal(e, options?.signal)
				await cleanup(isSignalAbort ? "SignalAbort" : "Error", e).catch(() => { })

				// byobRequest が存在する場合、controller.close() を呼んだだけでは
				// Promise は解決されず、respond() も呼ぶ必要がある。
				// controller.error() も同様の挙動になる可能性がある。(要検証)
				// 少なくとも throw すれば Promise は解決されるため、現状はこの実装とする。
				throw e
			}
		},

		async cancel(reason) {
			await cleanup("Cancel", reason)
		}
	})
}


export type CreateWritableStreamHandlerReleaseType = "Close" | "Abort" | "SignalAbort" | "Error"

export type CreateWritableStreamHandler = {

	/**
	 * A callback invoked when a new chunk of byte data is ready to be written.
	 * 
	 * - **Data Chunk**: Receives a `Uint8Array` containing the data. The exact size and memory reference of this chunk depend on the stream's `bufferSize` and `strictBufferSize` options.
	 * - **Data Safety**: If `options.useBufferView` is `true`, the `chunk` might be a direct view (subarray) of the internal buffer. To prevent data corruption, do not retain references to this view outside this callback.
	 * - **Handling Errors**: If an error is thrown inside this function, the stream will enter an error state and terminate.
	 */
	write: (chunk: Uint8Array<ArrayBuffer>) => PromiseLike<void> | void,

	/**
	 * A callback for performing cleanup operations.
	 * 
	 * This function is guaranteed to be invoked at most once. 
	 * It is automatically triggered when the stream terminates under any of the following conditions:
	 * - The stream or its writer is explicitly closed. (type: `"Close"`)
	 * - The stream or its writer is explicitly aborted. (type: `"Abort"`)
	 * - The provided `AbortSignal` fires an `abort` event. (type: `"SignalAbort"`)
	 * - An error occurs during a write operation. (type: `"Error"`)
	 */
	release?: (
		type: CreateWritableStreamHandlerReleaseType,
		reason?: unknown
	) => PromiseLike<void> | void,
}

export type CreateWritableStreamOptions = {

	/**
	 * An `AbortSignal` to abort the stream.
	 * 
	 * When the abort event is fired, the handler's `release` function will be called.
	 */
	signal?: AbortSignal,

	/**
	 * The size of the internal buffer in bytes.
	 * 
	 * Defaults to `0` (unbuffered).
	 */
	bufferSize?: number,

	/**
	 * If `true`, the stream strictly enforces the `bufferSize` for every chunk passed to the handler.
	 * Only the final `write` call may receive a chunk smaller than the `bufferSize`.
	 * 
	 * If `false`, chunks larger than the `bufferSize` will bypass the internal buffer and be processed directly.
	 * 
	 * Defaults to `false`.
	 */
	strictBufferSize?: boolean,

	/**
	 * If `true`, the handler's `write` method can receive a chunk as a view (subarray) of the internal buffer.
	 * This reduces the number of memory copies, but the received chunk must not be referenced outside the `write` method.
	 * If you need to retain the chunk data externally, you must make a copy of it within the `write` method.
	 * 
	 * Defaults to `false`.
	 */
	useBufferView?: boolean,
}

/**
 * Creates a `WritableStream` that writes byte data using the provided custom handler.
 * 
 * This function itself does not throw errors.
 * If you need to throw an error early when the provided `options.signal` is already aborted, 
 * the caller must check and handle it manually.
 * 
 * @param handler - The stream handler: `write`, `release`. See `CreateWritableStreamHandler` for details.
 * @param options - Optional settings: `signal`, `bufferSize`, `strictBufferSize`, `useBufferView`. See `CreateWritableStreamOptions` for details.
 * @returns A `WritableStream<Uint8Array<ArrayBufferLike>>` instance configured with the provided handler and options.
 */
export function createWritableStream(
	handler: CreateWritableStreamHandler,
	options?: CreateWritableStreamOptions,
): WritableStream<Uint8Array<ArrayBufferLike>> {

	const bufferSize = Math.max(0, Math.ceil(options?.bufferSize ?? 0))

	let abortListener: (() => void) | null = null;
	let buffer: Uint8Array<ArrayBuffer> | null = null;
	let bufferOffset = 0;

	let cleanupPromise: Promise<void> | null = null;
	function cleanup(
		type: CreateWritableStreamHandlerReleaseType,
		reason?: unknown
	): Promise<void> {

		if (cleanupPromise === null) {
			cleanupPromise = (async () => {
				buffer = null
				if (options?.signal != null && abortListener != null) {
					options?.signal?.removeEventListener("abort", abortListener)
					abortListener = null
				}
				if (handler.release != null) {
					await handler.release(type, reason)
				}
			})()
		}
		return cleanupPromise
	}

	return new WritableStream<Uint8Array<ArrayBufferLike>>({

		start(controller) {
			if (options?.signal != null) {
				abortListener = () => {
					const reason = options?.signal?.reason ?? newAbortSignalDefaultError()
					cleanup("SignalAbort", reason).catch(() => { })
					controller.error(reason)
				}
				options?.signal.addEventListener("abort", abortListener);
			}
		},

		async write(src) {
			try {
				throwIfAborted(options?.signal)

				// bufferSize が 0 以下の場合や src が buffer より大きい場合は buffer を使わずに処理する。
				if (
					bufferSize <= 0 ||
					(bufferSize <= src.byteLength && options?.strictBufferSize !== true)
				) {

					// buffer に既にデータがある場合、それを処理する。
					if (buffer !== null && 0 < bufferOffset) {
						const chunk = options?.useBufferView === true
							? buffer.subarray(0, bufferOffset)
							: buffer.slice(0, bufferOffset)

						throwIfAborted(options?.signal)
						await handler.write(chunk)
						bufferOffset = 0
					}

					throwIfAborted(options?.signal)
					await handler.write(mapToArrayBuffer(src))
					return
				}

				let srcOffset = 0;
				while (srcOffset < src.byteLength) {
					throwIfAborted(options?.signal)
					if (buffer === null) {
						buffer = new Uint8Array(bufferSize)
					}

					const n = Math.min(bufferSize - bufferOffset, src.byteLength - srcOffset)
					buffer.set(src.subarray(srcOffset, srcOffset + n), bufferOffset)
					bufferOffset += n
					srcOffset += n

					if (bufferOffset === bufferSize) {
						throwIfAborted(options?.signal)

						const chunk = buffer
						if (options?.useBufferView !== true) {
							buffer = null
						}
						await handler.write(chunk)
						bufferOffset = 0
					}
				}
			}
			catch (e) {
				const isSignalAbort = isThrownByAbortSignal(e, options?.signal)
				await cleanup(isSignalAbort ? "SignalAbort" : "Error", e).catch(() => { })
				throw e
			}
		},

		async close() {
			try {
				if (0 < bufferOffset && buffer != null) {
					const view = buffer.subarray(0, bufferOffset)
					buffer = null
					await handler.write(view)
				}
				await cleanup("Close")
			}
			catch (e) {
				await cleanup("Error", e).catch(() => { })
				throw e
			}
		},

		async abort(reason) {
			await cleanup("Abort", reason)
		}
	})
}


let _isReadableByteStreamAvailable: boolean | null = null
function isReadableByteStreamAvailable() {
	if (_isReadableByteStreamAvailable === null) {
		try {
			new ReadableStream({ type: "bytes" })
			_isReadableByteStreamAvailable = true
		}
		catch {
			_isReadableByteStreamAvailable = false
		}
	}

	return _isReadableByteStreamAvailable
}

function throwIfAborted(signal: AbortSignal | undefined | null) {
	if (signal?.aborted === true) {
		throw (signal?.reason ?? newAbortSignalDefaultError())
	}
}

function newAbortSignalDefaultError(): Error {
	return new DOMException("The operation was aborted.", "AbortError")
}

function isThrownByAbortSignal(err: unknown, signal: AbortSignal | null | undefined): boolean {
	return (signal?.aborted === true) &&
		(err === signal.reason || (err instanceof DOMException && err.name === "AbortError"));
}

function mapToArrayBuffer(
	buffer: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {

	return buffer.buffer instanceof ArrayBuffer
		? buffer as Uint8Array<ArrayBuffer>
		: new Uint8Array(buffer)
}
