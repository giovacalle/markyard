// Raw Web stream plumbing for file bodies (ADR 0003 constraint 1): bytes never go through an
// Effect `Stream`, so `Content-Length` is kept and chunks never pile up on the JS heap.

interface FixedLengthStreamConstructor {
  new (length: number | bigint): TransformStream<Uint8Array, Uint8Array>;
}

/**
 * `RequestInit` for a streamed upload of exactly `length` bytes, sent with a `Content-Length`
 * rather than chunked encoding. On workerd the body is piped through a `FixedLengthStream`;
 * elsewhere (Node 24) the header is set by hand, which `fetch` honours on a `duplex: "half"`
 * stream and enforces (a length mismatch fails the request). The body is never collected.
 */
export const fixedLengthInit = (
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: ReadableStream<Uint8Array>;
  },
  length: number,
): RequestInit => {
  const FixedLengthStream = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor })
    .FixedLengthStream;
  return FixedLengthStream === undefined
    ? streamInit({ ...init, headers: { ...init.headers, "content-length": String(length) } })
    : streamInit({ ...init, body: init.body.pipeThrough(new FixedLengthStream(length)) });
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
