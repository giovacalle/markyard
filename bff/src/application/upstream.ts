// Helpers over the `Upstream` port shared by the auth use cases and the Drive client.

import * as Effect from "effect/Effect";

import { parseJson } from "../domain/session.ts";
import { Upstream, UpstreamUnreachable } from "./ports.ts";

/** A response whose body was read in full, like the Rust `Upstream::send` answer. */
export interface Buffered {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
  /** The body parsed as JSON, or `undefined` when it is not JSON. */
  readonly json: unknown;
}

export const readBuffered = (res: Response): Effect.Effect<Buffered, UpstreamUnreachable> =>
  Effect.tryPromise({
    try: () => res.text(),
    catch: (cause) => new UpstreamUnreachable({ cause }),
  }).pipe(
    Effect.map((text) => ({
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      json: parseJson(text),
    })),
  );

/** Sends a request and reads the whole answer. */
export const sendBuffered = (
  request: Request,
): Effect.Effect<Buffered, UpstreamUnreachable, Upstream> =>
  Effect.gen(function* () {
    const upstream = yield* Upstream;
    const res = yield* upstream.send(request);
    return yield* readBuffered(res);
  });

/** A form-encoded POST (`application/x-www-form-urlencoded`, fields in the given order). */
export const formPost = (url: string, fields: ReadonlyArray<readonly [string, string]>): Request =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields.map(([k, v]) => [k, v])).toString(),
  });

export const bearer = (accessToken: string): string => `Bearer ${accessToken}`;
