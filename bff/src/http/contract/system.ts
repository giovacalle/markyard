import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

export const Health = Schema.Struct({ status: Schema.String, version: Schema.String });

/** `GET /api/health`. */
export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/api/health", { success: Health }),
) {}
