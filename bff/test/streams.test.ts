// `fixedLengthInit` on both hosts: workerd's `FixedLengthStream`, or a hand-set `Content-Length`.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { fixedLengthInit } from "../src/infrastructure/streams.ts";

const stream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (c) => {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });

describe("fixedLengthInit", () => {
  const globals = globalThis as { FixedLengthStream?: unknown };
  afterEach(() => {
    delete globals.FixedLengthStream;
  });

  it("sets Content-Length by hand and keeps the stream when FixedLengthStream is missing", () => {
    const body = stream();
    const init = fixedLengthInit({ method: "PUT", headers: { a: "1" }, body }, 3);
    expect(init.body).toBe(body);
    expect(init.headers).toEqual({ a: "1", "content-length": "3" });
    expect((init as { duplex?: string }).duplex).toBe("half");
  });

  it("pipes through FixedLengthStream on workerd and leaves the headers alone", () => {
    const lengths: Array<number> = [];
    globals.FixedLengthStream = class extends TransformStream {
      constructor(length: number) {
        super();
        lengths.push(length);
      }
    };
    const body = stream();
    const init = fixedLengthInit({ method: "PUT", headers: { a: "1" }, body }, 3);
    expect(lengths).toEqual([3]);
    expect(init.body).not.toBe(body);
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.headers).toEqual({ a: "1" });
    expect((init as { duplex?: string }).duplex).toBe("half");
  });
});
