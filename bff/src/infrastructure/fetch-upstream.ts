// The `Upstream` port over a Web `fetch` (the Workers global in production, a fake in tests).

import * as Effect from "effect/Effect";

import { UpstreamUnreachable, type Upstream } from "../application/ports.ts";

export type FetchFn = (request: Request) => Promise<Response>;

export const fetchUpstream = (fetchFn: FetchFn): Upstream["Service"] => ({
  send: (request) =>
    Effect.tryPromise({
      try: () => fetchFn(request),
      catch: (cause) => new UpstreamUnreachable({ cause }),
    }),
});
