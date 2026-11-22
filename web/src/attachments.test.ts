import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  ApiError,
  AttachmentError,
  fetchRevisionContent,
  fetchRevisions,
  MAX_ATTACHMENT_BYTES,
  NotUtf8Error,
  uploadAttachment,
} from "./api";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  Reflect.deleteProperty(navigator, "onLine");
});

afterAll(() => {
  server.close();
});

function png(size = 8, name = "shot.png"): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

describe("uploadAttachment", () => {
  it("posts the raw bytes with the image type and a percent-encoded filename", async () => {
    let seen: { type: string | null; filename: string | null; size: number } | null = null;
    server.use(
      http.post("/api/attachments", async ({ request }) => {
        seen = {
          type: request.headers.get("Content-Type"),
          filename: request.headers.get("X-Filename"),
          size: (await request.arrayBuffer()).byteLength,
        };
        return HttpResponse.json(
          {
            id: "img-1",
            name: "café.png",
            mimeType: "image/png",
            size: 8,
            url: "/api/files/img-1/blob",
          },
          { status: 201 },
        );
      }),
    );

    const uploaded = await uploadAttachment(png(8, "café.png"));

    expect(uploaded).toEqual({
      id: "img-1",
      name: "café.png",
      mimeType: "image/png",
      size: 8,
      url: "/api/files/img-1/blob",
    });
    expect(seen).toEqual({ type: "image/png", filename: "caf%C3%A9.png", size: 8 });
  });

  it("refuses unsupported types, oversize files and offline uploads before any request", async () => {
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    await expect(uploadAttachment(svg)).rejects.toMatchObject({
      name: "AttachmentError",
      reason: "unsupported_type",
    });

    const huge = new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], { type: "image/jpeg" });
    await expect(uploadAttachment(huge, "big.jpg")).rejects.toMatchObject({ reason: "too_large" });

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await expect(uploadAttachment(png())).rejects.toBeInstanceOf(AttachmentError);
    await expect(uploadAttachment(png())).rejects.toMatchObject({ reason: "offline" });
  });

  it("surfaces BFF errors as ApiError", async () => {
    server.use(
      http.post("/api/attachments", () =>
        HttpResponse.json({ code: "too_large", message: "Too large" }, { status: 413 }),
      ),
    );
    const error = await uploadAttachment(png()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
  });
});

describe("revisions", () => {
  it("lists revisions and decodes revision bytes as UTF-8", async () => {
    server.use(
      http.get("/api/files/:id/revisions", ({ params }) =>
        HttpResponse.json({
          revisions: [
            {
              id: `${String(params.id)}-r2`,
              modifiedTime: "2026-11-20T10:00:00.000Z",
              keepForever: false,
            },
          ],
        }),
      ),
      http.get(
        "/api/files/:id/revisions/:rev",
        ({ params }) =>
          new HttpResponse(new TextEncoder().encode(`rev ${String(params.rev)} ✓`), {
            headers: { "Content-Type": "application/octet-stream" },
          }),
      ),
    );

    expect(await fetchRevisions("doc")).toEqual([
      { id: "doc-r2", modifiedTime: "2026-11-20T10:00:00.000Z", keepForever: false },
    ]);
    expect(await fetchRevisionContent("doc", "r 1")).toBe("rev r 1 ✓");
  });

  it("rejects revision bytes that are not UTF-8", async () => {
    server.use(
      http.get(
        "/api/files/:id/revisions/:rev",
        () => new HttpResponse(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 }),
      ),
    );
    await expect(fetchRevisionContent("doc", "r1")).rejects.toBeInstanceOf(NotUtf8Error);
  });
});
