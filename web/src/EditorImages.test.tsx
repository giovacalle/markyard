import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { MAX_ATTACHMENT_BYTES } from "./api";
import { Editor } from "./components/Editor";

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

function mountEditor(initialText: string) {
  const onChange = vi.fn<(text: string) => void>();
  const result = render(<Editor initialText={initialText} onChange={onChange} />);
  const textbox = result
    .getByTestId("editor-host")
    .shadowRoot?.querySelector<HTMLElement>('[role="textbox"]');
  const view = textbox ? EditorView.findFromDOM(textbox) : null;
  if (!view) {
    throw new Error("EditorView not found in the shadow root");
  }
  return { view, onChange, ...result };
}

function image(name = "shot.png", type = "image/png", size = 16): File {
  return new File([new Uint8Array(size)], name, { type });
}

function pasteFiles(view: EditorView, files: File[], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      types: ["Files"],
      getData: (format: string) => (format === "text/plain" ? text : ""),
    },
  });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
  return event;
}

function dataTransfer(files: File[]) {
  return { files, types: ["Files"], items: [], dropEffect: "none", getData: () => "" };
}

/** Holds `POST /api/attachments` until `release` answers it. */
function deferredUpload(answer: () => Response = () => uploaded("img-1", "shot.png")) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: { type: string | null; filename: string | null }[] = [];
  server.use(
    http.post("/api/attachments", async ({ request }) => {
      requests.push({
        type: request.headers.get("Content-Type"),
        filename: request.headers.get("X-Filename"),
      });
      await gate;
      return answer();
    }),
  );
  return { release: () => act(async () => release()), requests };
}

function uploaded(id: string, name: string) {
  return HttpResponse.json(
    { id, name, mimeType: "image/png", size: 16, url: `/api/files/${id}/blob` },
    { status: 201 },
  );
}

describe("Editor inline images", () => {
  it("pastes a screenshot as a placeholder, keeps tracking it while typing, then links the blob", async () => {
    const upload = deferredUpload(() => uploaded("img-1", "Screen Shot.png"));
    const { view, onChange } = mountEditor("Intro\n");
    act(() => {
      view.dispatch({ selection: { anchor: 6 } });
    });

    const event = pasteFiles(view, [image("Screen Shot.png")]);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Intro\n![Uploading Screen Shot.png…]()");
    expect(screen.getByRole("status")).toHaveTextContent("Uploading 1 image…");

    // The user keeps typing before and after the placeholder while the upload runs.
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# " } });
      view.dispatch({ changes: { from: view.state.doc.length, insert: " after" } });
    });

    await upload.release();
    await waitFor(() =>
      expect(view.state.doc.toString()).toBe(
        "# Intro\n![Screen Shot](/api/files/img-1/blob) after",
      ),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      "# Intro\n![Screen Shot](/api/files/img-1/blob) after",
    );
    expect(upload.requests).toEqual([{ type: "image/png", filename: "Screen%20Shot.png" }]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps text pastes on the text path when the clipboard also carries an image", () => {
    const { view } = mountEditor("");
    pasteFiles(view, [image()], "plain words");
    // No upload handler is registered: an upload attempt would fail on the unhandled request.
    expect(view.state.doc.toString()).not.toContain("Uploading");
  });

  it("uploads image files dropped on the editor and highlights the drop target while dragging", async () => {
    const upload = deferredUpload(() => uploaded("img-9", "diagram.webp"));
    const { view, getByTestId } = mountEditor("A\n");
    const host = getByTestId("editor-host");

    fireEvent.dragOver(view.contentDOM, { dataTransfer: dataTransfer([image()]) });
    expect(host).toHaveAttribute("data-drop-target", "true");
    fireEvent.dragLeave(view.contentDOM, { dataTransfer: dataTransfer([]) });
    expect(host).not.toHaveAttribute("data-drop-target");

    fireEvent.dragOver(view.contentDOM, { dataTransfer: dataTransfer([image()]) });
    act(() => {
      view.dispatch({ selection: { anchor: 2 } });
    });
    fireEvent.drop(view.contentDOM, {
      dataTransfer: dataTransfer([image("diagram.webp", "image/webp")]),
    });
    expect(host).not.toHaveAttribute("data-drop-target");
    expect(view.state.doc.toString()).toBe("A\n![Uploading diagram.webp…]()");

    await upload.release();
    await waitFor(() =>
      expect(view.state.doc.toString()).toBe("A\n![diagram](/api/files/img-9/blob)"),
    );
    expect(upload.requests[0].type).toBe("image/webp");
  });

  it("uploads a photo picked with the Insert image button", async () => {
    server.use(http.post("/api/attachments", () => uploaded("img-3", "IMG_0001.jpg")));
    const { view } = mountEditor("");
    const input = screen.getByLabelText("Choose an image to insert");
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp,image/gif");
    expect(screen.getByRole("button", { name: "Insert image" })).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [image("IMG_0001.jpg", "image/jpeg")] } });

    await waitFor(() =>
      expect(view.state.doc.toString()).toBe("![IMG_0001](/api/files/img-3/blob)"),
    );
  });

  it("removes the placeholder and shows a dismissible error when the upload fails", async () => {
    const upload = deferredUpload(() =>
      HttpResponse.json({ code: "upstream_error", message: "Drive failed" }, { status: 502 }),
    );
    const { view, onChange } = mountEditor("Keep me");
    act(() => {
      view.dispatch({ selection: { anchor: 7 } });
    });
    pasteFiles(view, [image()]);
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    });

    await upload.release();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to add “shot.png”");
    expect(alert).toHaveTextContent("HTTP 502 upstream_error");
    expect(view.state.doc.toString()).toBe("Keep me!");
    expect(onChange).toHaveBeenLastCalledWith("Keep me!");

    // Undo never brings the stale placeholder back.
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).not.toContain("Uploading");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses unsupported, oversize and offline images without touching the note", () => {
    const { view, onChange } = mountEditor("Text");

    pasteFiles(view, [image("anim.bmp", "image/bmp")]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "“anim.bmp” is not a supported image. Use PNG, JPEG, WebP or GIF.",
    );

    pasteFiles(view, [image("huge.png", "image/png", MAX_ATTACHMENT_BYTES + 1)]);
    expect(screen.getByRole("alert")).toHaveTextContent("“huge.png” is larger than 10 MB");

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    pasteFiles(view, [image()]);
    expect(screen.getByRole("alert")).toHaveTextContent("You are offline");

    expect(view.state.doc.toString()).toBe("Text");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the note alone when the user deleted the placeholder before the upload finished", async () => {
    const upload = deferredUpload();
    const { view } = mountEditor("");
    pasteFiles(view, [image()]);
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "rewritten" } });
    });
    await upload.release();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(view.state.doc.toString()).toBe("rewritten");
  });
});
