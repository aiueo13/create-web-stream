export type CreateReadableStreamHandlerSource = Uint8Array<ArrayBuffer> | null | undefined

export type CreateReadableStreamHandlerReleaseType = "Close" | "Cancel" | "SignalAbort" | "Error"

export type CreateReadableStreamHandler = {

	/**
	 * A callback invoked when the stream's consumer requests more data.
	 * 
	 * - **Yielding data**: Return a `Uint8Array` containing the next chunk of bytes.
	 * - **Ending the stream**: Return `null`, `undefined`, or an empty `Uint8Array` (`byteLength === 0`) to signal that no more data is available. This will automatically close the stream.
	 * - **Handling errors**: If an error is thrown inside this function, the stream will enter an error state and terminate.
	 * 
	 * @returns The next chunk of bytes.
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
	 * 
	 * Note that it will not be invoked if `createReadableStream` function itself throws an error.
	 * 
	 * @param type - The type of the release operation.
	 * @param reason - The reason for the release operation.
	 */
	release?: (type: CreateReadableStreamHandlerReleaseType, reason?: unknown) => PromiseLike<void> | void,
}

export type CreateReadableStreamOptions = {

	/**
	 * An `AbortSignal` to abort the stream.
	 * 
	 * When the abort event is fired, the handler's `release` function will be called.
	 */
	signal?: AbortSignal,

	/**
	 * If `true`, checks the `signal` immediately upon stream creation.
	 * If the signal is already aborted, it throws an error early.
	 * If `false`, an error will be thrown during the first read operation of the stream.
	 * 
	 * Defaults to `true`.
	 */
	checkSignalEarly?: boolean,

	/**
	 * @internal
	 * @ignore
	 */
	__internal_useByteStream__?: boolean
}

/**
 * Creates a `ReadableStream` that yields byte data using the provided custom handler.
 * 
 * The resulting stream can provide a BYOB reader if supported by the runtime.
 * If unsupported, only a default reader is available.
 * 
 * @param handler - The stream handler: `read`, `release`. See `CreateReadableStreamHandler` for details.
 * @param options - Optional settings: `signal`, `checkSignalEarly`. See `CreateReadableStreamOptions` for details.
 * @returns A `ReadableStream<Uint8Array<ArrayBuffer>>` configured with the provided handler and options.
 */
export function createReadableStream(
	handler: CreateReadableStreamHandler,
	options?: CreateReadableStreamOptions,
): ReadableStream<Uint8Array<ArrayBuffer>> {

	const checkSignalEarly = options?.checkSignalEarly ?? true
	if (checkSignalEarly) {
		throwIfAborted(options?.signal)
	}

	const read = handler.read
	const release = handler.release

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
				if (release != null) {
					await release(type, reason)
				}
			})()
		}
		return cleanupPromise
	}

	const useByteStream = (options?.__internal_useByteStream__ !== undefined)
		? options.__internal_useByteStream__
		: isReadableByteStreamAvailable()

	if (!useByteStream) {
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
					const data = await read()
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
					buffer = (await read()) ?? null
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


export type CreateBYOBReadableStreamHandlerReleaseType = "Close" | "Cancel" | "SignalAbort" | "Error"

export type CreateBYOBReadableStreamHandler = {

	/**
	 * A callback invoked when the stream's consumer requests more data.
	 *
	 * - **Yielding data**: Write bytes into the provided `buffer` and return the number of bytes written (1 or greater). The returned value must not exceed `buffer.byteLength`.
	 * - **Ending the stream**: Return `0` to signal that no more data is available. This will automatically close the stream.
	 * - **Handling errors**: If an error is thrown inside this function, the stream will enter an error state and terminate.
	 * 
	 * @param buffer - The buffer to write the data into.
	 * @returns The number of bytes written.
	 */
	read: (buffer: Uint8Array<ArrayBuffer>) => PromiseLike<number> | number

	/**
	 * An optional callback for performing cleanup operations.
	 * 
	 * This function is guaranteed to be invoked at most once. 
	 * It is automatically triggered when the stream terminates under any of the following conditions:
	 * - The stream's reader is successfully read to the end. (type: `"Close"`)
	 * - The stream or its reader is explicitly canceled. (type: `"Cancel"`)
	 * - The provided `AbortSignal` fires an `abort` event. (type: `"SignalAbort"`)
	 * - An error occurs during a read operation. (type: `"Error"`)
	 * 
	 * Note that it will not be invoked if `createBYOBReadableStream` function itself throws an error.
	 * 
	 * @param type - The type of the release operation.
	 * @param reason - The reason for the release operation.
	 */
	release?: (type: CreateBYOBReadableStreamHandlerReleaseType, reason?: unknown) => PromiseLike<void> | void,
}

export type CreateBYOBReadableStreamOptions = {

	/**
	 * An `AbortSignal` to abort the stream.
	 * 
	 * When the abort event is fired, the handler's `release` function will be called.
	 */
	signal?: AbortSignal,

	/**
	 * If `true`, checks the `signal` immediately upon stream creation.
	 * If the signal is already aborted, it throws an error early.
	 * If `false`, an error will be thrown during the first read operation of the stream.
	 * 
	 * Defaults to `true`.
	 */
	checkSignalEarly?: boolean,

	/**
	 * @internal
	 * @ignore
	 */
	__internal_useByteStream__?: boolean
}

/**
 * Creates a `ReadableStream` that yields byte data using a BYOB-style handler.
 *
 * The resulting stream can provide a BYOB reader if supported by the runtime.
 * If unsupported, only a default reader is available.
 *
 * @param handler - The stream handler: `read`, `release`. See `CreateBYOBReadableStreamHandler` for details.
 * @param defaultBufferSize - The size of the fallback buffer passed to `handler.read`. Must be a positive safe integer. Used as `autoAllocateChunkSize` when a bytes-type reader is available. If unsupported, used as the size of the internal buffer for a default reader.
 * @param options - Optional settings: `signal`, `checkSignalEarly`. See `CreateBYOBReadableStreamOptions` for details.
 * @returns A `ReadableStream<Uint8Array<ArrayBuffer>>` configured with the provided handler and options.
 */
export function createBYOBReadableStream(
	handler: CreateBYOBReadableStreamHandler,
	defaultBufferSize: number,
	options?: CreateBYOBReadableStreamOptions,
): ReadableStream<Uint8Array<ArrayBuffer>> {

	const checkSignalEarly = options?.checkSignalEarly ?? true
	if (checkSignalEarly) {
		throwIfAborted(options?.signal)
	}

	requiresNonzeroSafeInt(defaultBufferSize, "defaultBufferSize")
	const read = handler.read
	const release = handler.release

	let abortListener: (() => void) | null = null
	let buffer: Uint8Array<ArrayBuffer> | null = null

	let cleanupPromise: Promise<void> | null = null
	function cleanup(
		type: CreateBYOBReadableStreamHandlerReleaseType,
		reason?: unknown
	): Promise<void> {

		if (cleanupPromise === null) {
			cleanupPromise = (async () => {
				buffer = null
				if (options?.signal != null && abortListener != null) {
					options.signal.removeEventListener("abort", abortListener)
					abortListener = null
				}
				if (release != null) {
					await release(type, reason)
				}
			})()
		}
		return cleanupPromise
	}

	const useByteStream = (options?.__internal_useByteStream__ !== undefined)
		? options.__internal_useByteStream__
		: isReadableByteStreamAvailable()

	if (!useByteStream) {
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
					if (buffer === null) {
						buffer = new Uint8Array(defaultBufferSize)
					}

					throwIfAborted(options?.signal)
					const nread = await read(buffer)
					throwIfAborted(options?.signal)

					requiresSafeUint(nread, "nread")
					if (nread === 0) {
						await cleanup("Close")
						controller.close()
						return
					}

					controller.enqueue(buffer.slice(0, nread))
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

	return new ReadableStream({
		type: "bytes",
		autoAllocateChunkSize: defaultBufferSize,

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
				const byob = controller.byobRequest
				if (byob == null) {
					if (buffer == null) {
						buffer = new Uint8Array(defaultBufferSize)
					}

					throwIfAborted(options?.signal)
					const nread = await read(buffer)
					throwIfAborted(options?.signal)

					requiresSafeUint(nread, "nread")
					if (nread === 0) {
						await cleanup("Close")
						controller.close()
						return
					}

					controller.enqueue(buffer.slice(0, nread))
					return
				}

				const v = byob.view
				if (v == null) return
				const view = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)

				throwIfAborted(options?.signal)
				const nread = await read(view)
				throwIfAborted(options?.signal)

				requiresSafeUint(nread, "nread")
				if (nread === 0) {
					await cleanup("Close")

					// byobRequest がある場合、respond を呼ばないと promise　が解決されない。
					// controller.close() の後だと respond(0) を読んでもエラーにはならない。
					// https://github.com/whatwg/streams/issues/1170
					controller.close()
					controller.byobRequest?.respond(0)
					return
				}

				byob.respond(nread)
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


export type CreateWritableStreamHandlerReleaseType = "Close" | "Abort" | "SignalAbort" | "Error"

export type CreateWritableStreamHandler = {

	/**
	 * A callback invoked when a new chunk of byte data is ready to be written.
	 * 
	 * - **Data Chunk**: Receives a `Uint8Array` containing the data. The exact size and memory reference of this chunk depend on the stream's `bufferSize` and `strictBufferSize` options.
	 * - **Data Safety**: If `options.useBufferView` is `true`, the `chunk` might be a direct view (subarray) of the internal buffer. To prevent data corruption, do not retain references to this view outside this callback.
	 * - **Handling Errors**: If an error is thrown inside this function, the stream will enter an error state and terminate.
	 * 
	 * @param chunk - The chunk of byte data to write.
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
	 * 
	 * Note that it will not be invoked if `createWritableStream` function itself throws an error.
	 * 
	 * @param type - The type of the release operation.
	 * @param reason - The reason for the release operation.
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
	 * If `true`, checks the `signal` immediately upon stream creation.
	 * If the signal is already aborted, it throws an error early.
	 * If `false`, an error will be thrown during the first write operation of the stream.
	 * 
	 * Defaults to `true`.
	 */
	checkSignalEarly?: boolean,

	/**
	 * The size of the internal buffer in bytes.  
	 * Must be a zero or positive safe integer.  
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
 * @param handler - The stream handler: `write`, `release`. See `CreateWritableStreamHandler` for details.
 * @param options - Optional settings: `signal`, `checkSignalEarly`, `bufferSize`, `strictBufferSize`, `useBufferView`. See `CreateWritableStreamOptions` for details.
 * @returns A `WritableStream<Uint8Array<ArrayBufferLike>>` instance configured with the provided handler and options.
 */
export function createWritableStream(
	handler: CreateWritableStreamHandler,
	options?: CreateWritableStreamOptions,
): WritableStream<Uint8Array<ArrayBufferLike>> {

	const checkSignalEarly = options?.checkSignalEarly ?? true
	if (checkSignalEarly) {
		throwIfAborted(options?.signal)
	}

	const write = handler.write
	const release = handler.release
	const bufferSize = options?.bufferSize ?? 0
	requiresSafeUint(bufferSize, "bufferSize")

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
				if (release != null) {
					await release(type, reason)
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
						await write(chunk)
						bufferOffset = 0
					}

					throwIfAborted(options?.signal)
					await write(mapToArrayBuffer(src))
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
						await write(chunk)
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
					await write(view)
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
function isReadableByteStreamAvailable(): boolean {
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

function requiresSafeUint(num: number, numName?: string): void {
	const name = numName ?? "value";

	if (!Number.isSafeInteger(num)) {
		throw new TypeError(`${name} must be a safe integer.`);
	}
	if (num < 0) {
		throw new RangeError(`${name} must be a positive integer.`);
	}
}

function requiresNonzeroSafeInt(num: number, numName?: string): void {
	const name = numName ?? "value";

	if (!Number.isSafeInteger(num)) {
		throw new TypeError(`${name} must be a safe integer.`);
	}
	if (num <= 0) {
		throw new RangeError(`${name} must be a non-zero positive integer.`);
	}
}