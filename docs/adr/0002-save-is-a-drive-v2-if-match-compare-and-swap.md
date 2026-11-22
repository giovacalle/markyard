---
status: accepted
---

# A save is a Drive v2 upload with `If-Match`; the revision tag is the v2 etag

Saving a note must not silently overwrite a change made elsewhere. Drive v3 has no precondition on file updates: a v3 upload carrying a stale `If-Match` answered 200. Spike A (#2, 2026-11-16) ran the v2 alternative against the live API on a `text/markdown` file and it passed the gate in #1, so the BFF saves through Drive **v2** and lets Drive do the compare-and-swap. The requests and responses are in the result comment on #2.

## The save

`PUT https://www.googleapis.com/upload/drive/v2/files/{id}?uploadType=media&fields=etag` with `Content-Type: text/markdown` and `If-Match: <etag>`.

- Current etag: 200, and the response body carries the new etag (the `ETag` response header carries the same value).
- Stale etag: 412 with reason `conditionNotMet`; content and etag unchanged.
- Two or more uploads sent together with the same etag: exactly one 200 in each of 11 races, the others 412.
- The file keeps `text/markdown`, is not converted, and downloads byte for byte, CRLF included.
- A 10 MB body, the file size cap from ADR 0001, went through `uploadType=media` with both outcomes.

Two values must never reach Drive from the web app's `If-Match`, so the BFF checks the tag's shape first:

- `If-Match: *` answered 200. Forwarded, it would turn a save into an unconditional overwrite.
- A value that is not an etag answered 500 `Unknown Error`, not 412.

## The revision tag

The revision tag is the v2 `etag` string, quotes included, opaque to the web app.

Reading a file takes two Drive requests, **metadata first, then content**: v2 `files.get?fields=etag,...`, then `alt=media`. The download response has no usable tag: v3 sends no `ETag` header, and v2 sends one with a different value that fails as `If-Match`. With metadata first, a write that lands between the two requests leaves the tag older than the content, and the next save answers 412: a false conflict, never a lost update. The other order could pair old content with a new tag.

## What the etag is

In all 68 metadata responses of the spike, the etag was the base64 of the file's `modifiedDate` in milliseconds. Google does not document this, and the BFF must not rebuild the etag from v3's `modifiedTime`. It explains the two behaviours below.

**What moves the etag without a content change** (a save with the older tag then answers 412): rename, description change, v2 `files.touch`. What does not: move to another folder, star and unstar, `viewedByMeTime`, opening the file in Drive's web preview, a download, a new sibling in the folder. A false conflict therefore needs another client to rename the file between open and save; the conflict notice already handles it.

v3's `version` also moved on a move, a star, `viewedByMeTime` and the web preview, six times for one look at the preview. As a tag it would report a conflict on every view.

**Known limit: a writer that keeps the modification time hides its change.** A v3 upload that replaced the content and set `modifiedTime` to the previous value left the etag unchanged, and a v2 save with the old etag then answered 200 and overwrote it. Tools that copy modification times can do this (rclone sets `modifiedTime` from the source file). Drive for desktop did not: an edit with the local modification time restored still moved the etag. `md5Checksum` and `version` do change in this case, but checking them is a read before the write, not part of the precondition. Not mitigated in the pre-alpha.

## Other writers

The etag changed, and a save with the older etag answered 412, after an edit by each of: a v3 `PATCH` upload, Drive for desktop (macOS, stream mode), Google's native `.md` editor.

## Standing risk

Conditional updates on v2 files are not described in Google's current documentation, which only lists `etag` as an output field. v2 has no deprecation or shutdown notice; Google's comparison guide says "If you're using v2, consider migrating to v3", and no v2 feature has shipped in 2025-2026. If the precondition stops being honoured, saves keep succeeding and conflicts stop being detected, with no error. The way back is the option below; the web-facing contract (`ETag`, `If-Match`, 412) stays the same.

## Considered options

- **v3 `version` read-compare-write**: the fallback in #1. Rejected: the check and the write are two requests, so two saves can both pass, and `version` moves on views.
- **`md5Checksum` or `headRevisionId` as the tag**: they follow content exactly, but nothing in Drive accepts them as a precondition.
