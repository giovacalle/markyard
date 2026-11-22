import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { Unauthenticated401, UpstreamError502 } from "../errors.ts";

/**
 * `cloudSync` is present (and `true`) only when the Worker has a state database bound;
 * `needsVaultSetup` (`true`) only when the account has no vault root yet.
 */
export const SessionStatus = Schema.Struct({
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
  cloudSync: Schema.optionalKey(Schema.Boolean),
  needsVaultSetup: Schema.optionalKey(Schema.Boolean),
});

/** `GET /api/session` and `POST /api/auth/logout`. Login and callback are HTML: see `routes/auth-pages.ts`. */
export class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("status", "/api/session", {
      success: SessionStatus,
      error: [Unauthenticated401, UpstreamError502],
    }),
  )
  .add(HttpApiEndpoint.post("logout", "/api/auth/logout")) {}
