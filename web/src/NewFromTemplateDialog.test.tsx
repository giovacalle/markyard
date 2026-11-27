import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, type DriveNode } from "./api";
import { formatLocalDate } from "./commandSearch";
import {
  NewFromTemplateDialog,
  type NewFromTemplateRequest,
} from "./components/NewFromTemplateDialog";
import { clearLocalCache } from "./localCache";
import { resetSettings, updateSettings } from "./settings";
import { childrenKey } from "./treeCache";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(async () => {
  server.resetHandlers();
  resetSettings();
  window.localStorage.clear();
  await clearLocalCache();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-21T09:05:00.000Z";
const ROOT: DriveNode = { id: "root-id", name: "Notes", kind: "folder", modifiedTime: MODIFIED };

function node(id: string, name: string, kind: "folder" | "markdown" = "markdown"): DriveNode {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function makeQueryClient(rootChildren: DriveNode[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["root"], ROOT);
  client.setQueryData(childrenKey(ROOT.id), rootChildren);
  return client;
}

describe("NewFromTemplateDialog", () => {
  it("loads templates, expands chosen template with title/folder/cursor, and submits", async () => {
    updateSettings({ showAttachmentsFolder: false });
    const queryClient = makeQueryClient([
      node("tpl-dir", "Templates", "folder"),
      node("work-dir", "Work", "folder"),
    ]);
    queryClient.setQueryData(childrenKey("tpl-dir"), [
      node("tpl-meeting", "Meeting.md"),
      node("tpl-rfc", "RFC.md"),
    ]);
    queryClient.setQueryData(["files", "tpl-meeting", "content"], {
      text: "# Meeting: {{title}}\n",
      revision: "r1",
    });
    queryClient.setQueryData(["files", "tpl-rfc", "content"], {
      text: "# RFC: {{title}}\nFolder: {{folder}}\nDate: {{date}}\n\nSummary: {{cursor}}\n",
      revision: "r2",
    });

    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json({
          folders: [
            { id: "tpl-dir", name: "Templates", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "work-dir", name: "Work", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "q4-dir", name: "Q4", parentId: "work-dir", modifiedTime: MODIFIED },
            { id: "att-dir", name: "_attachments", parentId: "root-id", modifiedTime: MODIFIED },
          ],
          files: [],
        }),
      ),
    );

    const onClose = vi.fn();
    const onCreate = vi.fn<(req: NewFromTemplateRequest) => Promise<void>>().mockResolvedValue();

    render(
      <QueryClientProvider client={queryClient}>
        <NewFromTemplateDialog
          open
          rootFolder={ROOT}
          defaultFolderId="work-dir"
          onClose={onClose}
          onCreate={onCreate}
        />
      </QueryClientProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "New note from template" });
    // First template (alphabetically "Meeting") is pre-selected.
    const templateTrigger = await within(dialog).findByRole("combobox", { name: "Template" });
    expect(templateTrigger).toHaveTextContent("Meeting");

    // Default destination folder is Work (the open note's folder).
    expect(within(dialog).getByTestId("selected-folder-path")).toHaveTextContent("Notes / Work");

    // Attachments folder is hidden when showAttachmentsFolder is false.
    await within(dialog).findByRole("option", { name: "Notes / Work / Q4" });
    expect(within(dialog).queryByRole("option", { name: /_attachments/ })).toBeNull();

    // Switch template to RFC.
    fireEvent.click(templateTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "RFC" }));
    expect(templateTrigger).toHaveTextContent("RFC");

    // Enter note title.
    const titleInput = within(dialog).getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "Auth Overhaul" } });

    // Filter folders and select Notes / Work / Q4.
    const folderFilter = within(dialog).getByLabelText("Destination folder");
    fireEvent.change(folderFilter, { target: { value: "q4" } });
    const q4Option = within(dialog).getByRole("option", { name: "Notes / Work / Q4" });
    fireEvent.click(q4Option);
    expect(within(dialog).getByTestId("selected-folder-path")).toHaveTextContent(
      "Notes / Work / Q4",
    );

    // Submit form.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create note" }));

    const today = formatLocalDate();
    const expectedText = `# RFC: Auth Overhaul\nFolder: Work/Q4\nDate: ${today}\n\nSummary: \n`;
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        folder: { id: "q4-dir", name: "Q4" },
        name: "Auth Overhaul.md",
        content: expectedText,
        initialCursor: expectedText.indexOf("Summary: ") + "Summary: ".length,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a helpful empty state when no templates exist in the configured folder", async () => {
    updateSettings({ templatesFolder: "Blueprints" });
    const queryClient = makeQueryClient([]);
    server.use(http.get("/api/vault/index", () => HttpResponse.json({ folders: [], files: [] })));

    const onClose = vi.fn();
    const onCreate = vi.fn<(req: NewFromTemplateRequest) => Promise<void>>().mockResolvedValue();

    render(
      <QueryClientProvider client={queryClient}>
        <NewFromTemplateDialog open rootFolder={ROOT} onClose={onClose} onCreate={onCreate} />
      </QueryClientProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "New note from template" });
    expect(await within(dialog).findByText(/No templates found in/)).toHaveTextContent(
      "Blueprints",
    );
    expect(within(dialog).queryByRole("button", { name: "Create note" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("validates the note title and surfaces duplicate-name errors without closing", async () => {
    const queryClient = makeQueryClient([node("tpl-dir", "Templates", "folder")]);
    queryClient.setQueryData(childrenKey("tpl-dir"), [node("tpl-1", "Blank.md")]);
    queryClient.setQueryData(["files", "tpl-1", "content"], {
      text: "# {{title}}\n",
      revision: "r1",
    });
    server.use(http.get("/api/vault/index", () => HttpResponse.json({ folders: [], files: [] })));

    const onClose = vi.fn();
    const onCreate = vi
      .fn<(req: NewFromTemplateRequest) => Promise<void>>()
      .mockRejectedValue(new ApiError(409, "name_exists", "Already exists"));

    render(
      <QueryClientProvider client={queryClient}>
        <NewFromTemplateDialog open rootFolder={ROOT} onClose={onClose} onCreate={onCreate} />
      </QueryClientProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "New note from template" });
    const titleInput = await within(dialog).findByLabelText("Title");
    const submit = within(dialog).getByRole("button", { name: "Create note" });

    // Empty title is rejected.
    fireEvent.click(submit);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a file name.");
    expect(onCreate).not.toHaveBeenCalled();

    // Slash in title is rejected.
    fireEvent.change(titleInput, { target: { value: "bad/name" } });
    fireEvent.click(submit);
    expect(within(dialog).getByRole("alert")).toHaveTextContent('cannot contain "/"');
    expect(onCreate).not.toHaveBeenCalled();

    // Valid title submits; server 409 shows inline alert and keeps dialog open.
    fireEvent.change(titleInput, { target: { value: "Existing" } });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A file with this name already exists in this folder.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
