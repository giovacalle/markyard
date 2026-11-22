import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { bareUrlOf, Preview } from "./components/Preview";

const server = setupServer();
const requested: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  requested.length = 0;
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const RICH = {
  url: "https://example.com/post",
  finalUrl: "https://example.com/post",
  hostname: "example.com",
  title: "Example post",
  description: "A short description of the post.",
  siteName: "Example",
  image: "/api/link-preview/image?url=https%3A%2F%2Fexample.com%2Fog.png",
  favicon: "/api/link-preview/image?url=https%3A%2F%2Fexample.com%2Ffavicon.ico",
};

function serve(response: () => Response) {
  server.use(
    http.get("/api/link-preview", ({ request }) => {
      requested.push(new URL(request.url).searchParams.get("url") ?? "");
      return response();
    }),
  );
}

function renderPreview(text: string, client: QueryClient | null = new QueryClient()) {
  const tree = <Preview text={text} />;
  render(
    client === null ? tree : <QueryClientProvider client={client}>{tree}</QueryClientProvider>,
  );
}

describe("external link hover preview", () => {
  it("opens a card after a short hover, keeps it while on the card, and closes on Escape", async () => {
    serve(() => HttpResponse.json(RICH));
    renderPreview("Read [the post](https://example.com/post) today.");
    const link = screen.getByRole("link", { name: "the post" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.mouseEnter(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const card = await screen.findByRole("tooltip", { name: "Link preview" });
    expect(await within(card).findByText("Example post")).toBeInTheDocument();
    expect(within(card).getByText("A short description of the post.")).toBeInTheDocument();
    expect(within(card).getByText("Example")).toBeInTheDocument();
    expect(within(card).getByText("example.com/post")).toBeInTheDocument();
    expect(within(card).getByTestId("link-favicon")).toHaveAttribute("src", RICH.favicon);
    expect(card.querySelector(`img[src="${RICH.image}"]`)).not.toBeNull();
    expect(link).toHaveAttribute("aria-describedby", card.id);
    expect(card.getAttribute("style")).toMatch(/left: \d+px; top: \d+px/);
    expect(requested).toEqual(["https://example.com/post"]);

    fireEvent.mouseLeave(link);
    fireEvent.mouseEnter(card);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on keyboard focus and hides a broken image and favicon", async () => {
    serve(() => HttpResponse.json(RICH));
    renderPreview("[post](https://example.com/post)");
    fireEvent.focus(screen.getByRole("link", { name: "post" }));
    const card = await screen.findByRole("tooltip");
    await within(card).findByText("Example post");

    const image = card.querySelector(`img[src="${RICH.image}"]`);
    fireEvent.error(image as Element);
    fireEvent.error(within(card).getByTestId("link-favicon"));
    expect(card.querySelector(`img[src="${RICH.image}"]`)).toBeNull();
    expect(within(card).getByTestId("link-globe")).toBeInTheDocument();
  });

  it("shows a hostname-only card when the preview fails", async () => {
    serve(() => HttpResponse.json({ error: "unreachable" }, { status: 502 }));
    renderPreview("[post](https://www.example.com/post)");
    fireEvent.focus(screen.getByRole("link", { name: "post" }));
    const card = await screen.findByRole("tooltip");
    await waitFor(() => expect(within(card).queryByTestId("link-preview-loading")).toBeNull());
    expect(within(card).getByText("example.com")).toBeInTheDocument();
    expect(within(card).getByTestId("link-globe")).toBeInTheDocument();
  });

  it("stops click propagation", () => {
    serve(() => HttpResponse.json(RICH));
    const onClick = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        {/* biome-ignore lint: test wrapper */}
        <div onClick={onClick}>
          <Preview text="[post](https://example.com/post)" />
        </div>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "post" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("never fetches outside a QueryClient or for internal links", async () => {
    serve(() => HttpResponse.json(RICH));
    renderPreview("[post](https://example.com/post) and [local](/api/files/x/blob)", null);
    fireEvent.focus(screen.getByRole("link", { name: "post" }));
    fireEvent.focus(screen.getByRole("link", { name: "local" }));
    expect(screen.getByRole("link", { name: "local" })).not.toHaveAttribute("target");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requested).toEqual([]);
  });
});

describe("bare URL bookmark card", () => {
  it("upgrades a paragraph holding only a URL into a bookmark card", async () => {
    serve(() => HttpResponse.json({ ...RICH, url: "https://getsill.app/" }));
    renderPreview("Intro\n\nhttps://getsill.app/\n\nOutro");
    expect(screen.getByRole("link", { name: "https://getsill.app/" })).toBeInTheDocument();
    const card = await screen.findByTestId("link-bookmark");
    expect(card).toHaveAttribute("href", "https://getsill.app/");
    expect(card).toHaveAttribute("target", "_blank");
    expect(card).toHaveAccessibleName("Example post");
    expect(within(card).getByText("A short description of the post.")).toBeInTheDocument();
    expect(card.querySelector(`img[src="${RICH.image}"]`)).not.toBeNull();
    expect(requested).toEqual(["https://getsill.app/"]);
  });

  it("keeps the plain link when the preview fails or has no title", async () => {
    serve(() =>
      HttpResponse.json({
        url: "https://a.test/",
        finalUrl: "https://a.test/",
        hostname: "a.test",
      }),
    );
    renderPreview("https://a.test/");
    await waitFor(() => expect(requested).toEqual(["https://a.test/"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("link-bookmark")).toBeNull();
    expect(screen.getByRole("link", { name: "https://a.test/" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the plain link on errors and offline", async () => {
    serve(() => HttpResponse.json({ error: "boom" }, { status: 500 }));
    renderPreview("https://b.test/");
    await waitFor(() => expect(requested).toEqual(["https://b.test/"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("link-bookmark")).toBeNull();
    expect(screen.getByRole("link", { name: "https://b.test/" })).toBeInTheDocument();
  });

  it("does not fetch while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    serve(() => HttpResponse.json(RICH));
    renderPreview("https://c.test/");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requested).toEqual([]);
    expect(screen.getByRole("link", { name: "https://c.test/" })).toBeInTheDocument();
  });

  it("only treats a lone autolinked URL as bare", () => {
    const link = (href: string, label: string) => ({
      type: "element",
      tagName: "a",
      properties: { href },
      children: [{ type: "text", value: label }],
    });
    const p = (...children: object[]) => ({ type: "element", tagName: "p", children }) as never;
    expect(bareUrlOf(p(link("https://x.test/", "https://x.test/")))).toBe("https://x.test/");
    expect(bareUrlOf(p(link("https://x.test", "Example")))).toBeNull();
    expect(
      bareUrlOf(p({ type: "text", value: "see " }, link("https://x.test", "https://x.test"))),
    ).toBeNull();
    expect(bareUrlOf(p(link("/local", "/local")))).toBeNull();
  });
});
