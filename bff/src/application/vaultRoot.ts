// The vault root of a signed-in account. Each account picks its own Drive folder
// (`PUT /api/vault/root`); it travels in the sealed session cookie and, when cloud sync is bound,
// in the account's synced state so another device inherits it on its next `GET /api/session`.
// Without a pick, the account must choose a vault folder before using vault routes.

import * as Effect from "effect/Effect";

import { isLiveFolder, isValidId, toNode, type Node } from "../domain/drive.ts";
import {
  invalidRequest,
  notFound,
  vaultNotConfigured,
  type InvalidRequest,
  type UpstreamError,
} from "../domain/errors.ts";
import { parseJson, type Session } from "../domain/session.ts";
import { getFile, type DriveFailure, type DriveR } from "../infrastructure/drive-client.ts";
import { resealSession } from "./auth.ts";
import { CookieSealer, Entropy, ResponseSink, StateStore } from "./ports.ts";

/** The account's own vault folder, or `undefined` when not yet chosen. */
export const effectiveRootFolderId = (session: Session): string | undefined => session.rootFolderId;

/** The vault root of a route that needs one, or 400 `vault_not_configured`. */
export const requireVaultRoot = (session: Session): Effect.Effect<string, InvalidRequest> =>
  session.rootFolderId === undefined
    ? Effect.fail(vaultNotConfigured())
    : Effect.succeed(session.rootFolderId);

/**
 * The session with the vault folder stored in the synced state adopted (and its cookie resealed)
 * when it differs. A store failure leaves the session as it is: signing in must not depend on it.
 * Only a stored id counts; `null` or no key means no pick was synced.
 */
export const adoptStoredRoot = (
  session: Session,
): Effect.Effect<Session, never, StateStore | Entropy | CookieSealer | ResponseSink> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    if (!store.enabled) return session;
    const row = yield* Effect.orElseSucceed(store.get(session.email), () => null);
    const stored = row?.state.rootFolderId;
    if (typeof stored !== "string" || stored === session.rootFolderId) return session;
    const adopted: Session = { ...session, rootFolderId: stored };
    yield* resealSession(adopted);
    return adopted;
  });

const BAD_BODY = 'The request body must be JSON with a "folderId".';

const decodeFolderId = (bytes: Uint8Array): string | undefined => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const json = parseJson(text);
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const id = (json as Record<string, unknown>)["folderId"];
  return typeof id === "string" && isValidId(id) ? id : undefined;
};

/**
 * `PUT /api/vault/root`: make a live folder this account can see its vault root, in the session
 * cookie and, when cloud sync is bound, in the synced state (as a write newer than the stored one).
 */
export const selectVaultRoot = (
  session: Session,
  body: Uint8Array,
): Effect.Effect<
  { root: Node },
  DriveFailure | InvalidRequest | UpstreamError,
  DriveR | StateStore | Entropy | CookieSealer
> =>
  Effect.gen(function* () {
    const token = session.at ?? "";
    const folderId = decodeFolderId(body);
    if (folderId === undefined) return yield* Effect.fail(invalidRequest(BAD_BODY));
    const folder = yield* getFile(token, folderId);
    if (!isLiveFolder(folder) || !isValidId(folder.id)) return yield* Effect.fail(notFound());

    yield* resealSession({ ...session, rootFolderId: folder.id });

    const store = yield* StateStore;
    if (store.enabled) {
      const existing = yield* store.get(session.email);
      const nowMs = (yield* (yield* Entropy).nowSeconds) * 1000;
      const updatedAt = Math.max(nowMs, (existing?.updatedAt ?? 0) + 1);
      yield* store.put(session.email, { ...existing?.state, rootFolderId: folder.id }, updatedAt);
    }
    return { root: toNode(folder) };
  });
