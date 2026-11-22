import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { Api } from "../api.ts";

/** Kept equal to `bff/package.json` `version` (Rust used `CARGO_PKG_VERSION`). */
export const VERSION = "0.1.0";

export const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok", version: VERSION })),
);
