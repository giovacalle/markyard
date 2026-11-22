// The Drive Changes API behind `GET /api/changes/start-token` and `GET /api/changes`: the web app
// keeps a page token and asks what changed since, so it invalidates only what Drive reports.

import * as Effect from "effect/Effect";

import { isPageToken, toChange, type Change } from "../domain/drive.ts";
import { invalidRequest, type InvalidRequest, type TokenExpired } from "../domain/errors.ts";
import {
  getStartPageToken,
  listChanges,
  type DriveFailure,
  type DriveR,
} from "../infrastructure/drive-client.ts";

/** Drive pages (of up to 100 changes) one request follows before answering `hasMore: true`. */
export const MAX_CHANGE_PAGES = 5;

export interface ChangesResponse {
  /** Where the next call starts: more pages when `hasMore`, else the new start of the change log. */
  readonly nextPageToken: string;
  readonly hasMore: boolean;
  readonly changes: ReadonlyArray<Change>;
}

export const startToken = (
  token: string,
): Effect.Effect<{ startPageToken: string }, DriveFailure, DriveR> =>
  Effect.map(getStartPageToken(token), (startPageToken) => ({ startPageToken }));

/** The changes since `rawPageToken`, following at most `MAX_CHANGE_PAGES` Drive pages. */
export const changesSince = (
  token: string,
  rawPageToken: string | null,
): Effect.Effect<ChangesResponse, DriveFailure | InvalidRequest | TokenExpired, DriveR> =>
  Effect.gen(function* () {
    if (rawPageToken === null || !isPageToken(rawPageToken)) {
      return yield* Effect.fail(invalidRequest("A valid pageToken is required."));
    }
    const changes: Array<Change> = [];
    let pageToken = rawPageToken;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const { changes: batch, next } = yield* listChanges(token, pageToken);
      changes.push(...batch.map(toChange));
      if (!next.more) return { nextPageToken: next.token, hasMore: false, changes };
      pageToken = next.token;
    }
    return { nextPageToken: pageToken, hasMore: true, changes };
  });
