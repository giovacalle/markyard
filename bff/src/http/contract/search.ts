// `GET /api/search?q=`. Owned by the search phase-2 work. `q` is read from the raw URL by the
// handler, so a missing or odd query never earns HttpApi's own 400.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { VaultErrors } from "../errors.ts";
import { NodeSchema } from "./node.ts";

export const SearchResult = Schema.Struct({ node: NodeSchema, path: Schema.Array(Schema.String) });

export class SearchGroup extends HttpApiGroup.make("search").add(
  HttpApiEndpoint.get("search", "/api/search", {
    success: Schema.Struct({ results: Schema.Array(SearchResult) }),
    error: VaultErrors,
  }),
) {}
