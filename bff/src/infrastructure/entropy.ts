// The real clock and randomness of a request.

import * as Effect from "effect/Effect";

import type { Entropy } from "../application/ports.ts";

export const systemEntropy: Entropy["Service"] = {
  nowSeconds: Effect.sync(() => Math.floor(Date.now() / 1000)),
  random64: Effect.sync(() => crypto.getRandomValues(new Uint8Array(64))),
};
