// `GET`/`PUT /api/state`. The session is resolved first, then the state of its email is read or
// written; the `PUT` body is read raw and decoded by the use case.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as State from "../../application/state.ts";
import { Api } from "../api.ts";
import { bodyBytes, signedInSession as session } from "../request.ts";

export const StateLive = HttpApiBuilder.group(Api, "state", (handlers) =>
  handlers
    .handle("read", () => Effect.flatMap(session, (s) => State.read(s.email)))
    .handleRaw("write", () =>
      Effect.gen(function* () {
        const { email } = yield* session;
        return yield* State.write(email, yield* bodyBytes);
      }),
    ),
);
