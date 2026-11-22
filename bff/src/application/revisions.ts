// Drive version history use cases: list a file's revisions newest first, and stream the bytes
// of one revision. Both only answer for a live blob file (not a folder, a Google Doc, the trash).

import * as Effect from "effect/Effect";

import { MAX_FILE_BYTES, isLiveFile, isValidId } from "../domain/drive.ts";
import { driveUnreachable, notFound, type TooLarge, tooLarge } from "../domain/errors.ts";
import { newestFirst, type Revision } from "../domain/revisions.ts";
import * as Drive from "../infrastructure/drive-client.ts";

type DriveEffect<A, E = Drive.DriveFailure> = Effect.Effect<A, E, Drive.DriveR>;

/** A live blob file, or 404. */
const liveFile = (accessToken: string, id: string): DriveEffect<void> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const file = yield* Drive.getFile(accessToken, id);
    if (!isLiveFile(file)) return yield* Effect.fail(notFound());
  });

/** `GET /api/files/{id}/revisions`. */
export const listFileRevisions = (
  accessToken: string,
  id: string,
): DriveEffect<{ readonly revisions: ReadonlyArray<Revision> }> =>
  Effect.gen(function* () {
    yield* liveFile(accessToken, id);
    return { revisions: newestFirst(yield* Drive.listRevisions(accessToken, id)) };
  });

/**
 * `GET /api/files/{id}/revisions/{revisionId}`: the revision's size is checked against the 10 MB
 * cap before its bytes are asked for; the answer is Drive's media body, unread.
 */
export const readRevision = (
  accessToken: string,
  id: string,
  revisionId: string,
): DriveEffect<ReadableStream<Uint8Array> | null, Drive.DriveFailure | TooLarge> =>
  Effect.gen(function* () {
    if (!isValidId(revisionId)) return yield* Effect.fail(notFound());
    yield* liveFile(accessToken, id);
    const meta = yield* Drive.getRevisionMeta(accessToken, id, revisionId);
    if (meta.size === undefined) return yield* Effect.fail(driveUnreachable());
    if (meta.size > MAX_FILE_BYTES) return yield* Effect.fail(tooLarge());
    const res = yield* Drive.downloadRevision(accessToken, id, revisionId);
    return res.body;
  });
