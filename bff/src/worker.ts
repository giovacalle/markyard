// Cloudflare Worker entry. No `alchemy` or `@alchemy.run/cloudflare` import here (ADR 0003).

import { makeFetch } from "./http/app.ts";
import { systemEntropy } from "./infrastructure/entropy.ts";

const handle = makeFetch({ fetch: (request) => fetch(request), entropy: systemEntropy });

export default {
  fetch: (request: Request, env: Readonly<Record<string, unknown>>): Promise<Response> =>
    handle(request, env),
};
