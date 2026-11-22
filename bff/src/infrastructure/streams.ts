// Raw Web stream plumbing for file bodies (ADR 0003 constraint 1): bytes never go through an
// Effect `Stream`, so `Content-Length` is kept and chunks never pile up on the JS heap.

interface FixedLengthStreamConstructor {
  new (length: number | bigint): TransformStream<Uint8Array, Uint8Array>;
}

/**
 * Pipes `body` through a Workers `FixedLengthStream(length)`, so `fetch` sends a
 * `Content-Length` instead of chunked encoding. Outside workerd (tests) the stream is returned
 * as is.
 */
export const fixedLength = (
  body: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> => {
  const FixedLengthStream = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor })
    .FixedLengthStream;
  return FixedLengthStream === undefined ? body : body.pipeThrough(new FixedLengthStream(length));
};

/**
 * `body` with `head` sent before its first chunk and `tail` after its last, through a Web
 * `TransformStream`: the bytes are passed chunk by chunk, never collected (a multipart upload
 * whose file part is a raw stream).
 */
export const framed = (
  head: Uint8Array,
  body: ReadableStream<Uint8Array>,
  tail: Uint8Array,
): ReadableStream<Uint8Array> =>
  body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => controller.enqueue(head),
      flush: (controller) => controller.enqueue(tail),
    }),
  );

/**
 * `body` passed chunk by chunk through a Web `TransformStream` that errors the stream once more
 * than `max` bytes went by, so a body without a trustworthy `Content-Length` is still capped
 * without being collected.
 */
export const byteCapped = (
  body: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> => {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new RangeError(`body is larger than ${max} bytes`));
        else controller.enqueue(chunk);
      },
    }),
  );
};

/** `RequestInit` for a streamed request body (`duplex` is required by fetch for streams). */
export const streamInit = (init: RequestInit & { body: ReadableStream<Uint8Array> }): RequestInit =>
  ({ ...init, duplex: "half" }) as RequestInit;
