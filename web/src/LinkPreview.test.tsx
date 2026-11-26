import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ExternalLink } from "./components/LinkPreview";
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

/** HoverCard opens from pointer hover, not from React's synthetic mouseenter. */
function hover(element: Element) {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
}

/** HoverCard opens from keyboard focus only: a Tab press sets keyboard modality first. */
function keyboardFocus(element: HTMLElement) {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => {
    element.focus();
  });
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

    hover(link);
    expect(screen.queryByLabelText("Link preview")).toBeNull();
    const card = await screen.findByLabelText("Link preview");
    expect(card).toHaveAttribute("data-slot", "hover-card-content");
    expect(await within(card).findByText("Example post")).toBeInTheDocument();
    expect(within(card).getByText("A short description of the post.")).toBeInTheDocument();
    expect(within(card).getByText("Example")).toBeInTheDocument();
    expect(within(card).getByText("example.com/post")).toBeInTheDocument();
    expect(within(card).getByTestId("link-favicon")).toHaveAttribute("src", RICH.favicon);
    expect(card.querySelector(`img[src="${RICH.image}"]`)).not.toBeNull();
    expect(card).toHaveAttribute("data-open");
    expect(requested).toEqual(["https://example.com/post"]);

    fireEvent.pointerLeave(link, { pointerType: "mouse", relatedTarget: card });
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByLabelText("Link preview")).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByLabelText("Link preview")).toBeNull());
  });

  it("renders the link card as a ui-sdk HoverCard outside the paragraph that closes on scroll", async () => {
    const consoleError = vi.spyOn(console, "error");
    serve(() => HttpResponse.json(RICH));
    renderPreview("Read [the post](https://example.com/post) today.");
    const link = screen.getByRole("link", { name: "the post" });

    hover(link);
    const card = await screen.findByLabelText("Link preview");
    expect(card).toHaveAttribute("data-slot", "hover-card-content");
    expect(card.closest("p")).toBeNull();

    await waitFor(() => {
      fireEvent.scroll(window);
      expect(screen.queryByLabelText("Link preview")).toBeNull();
    });

    hover(link);
    await screen.findByLabelText("Link preview");
    await waitFor(() => {
      fireEvent(window, new Event("resize"));
      expect(screen.queryByLabelText("Link preview")).toBeNull();
    });

    const nesting = consoleError.mock.calls.filter((call) =>
      call.some((arg) => /cannot be a descendant|validateDOMNesting/.test(String(arg))),
    );
    expect(nesting).toEqual([]);
  });

  it("forwards the caller's mouse and focus handlers on a previewing link", () => {
    const enter = vi.fn();
    const leave = vi.fn();
    const focus = vi.fn();
    const blur = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLink
          href="https://example.com/post"
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={focus}
          onBlur={blur}
        >
          post
        </ExternalLink>
      </QueryClientProvider>,
    );
    const link = screen.getByRole("link", { name: "post" });
    expect(link).toHaveAttribute("data-slot", "hover-card-trigger");
    fireEvent.mouseEnter(link);
    fireEvent.mouseLeave(link);
    fireEvent.focus(link);
    fireEvent.blur(link);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("opens on keyboard focus and hides a broken image and favicon", async () => {
    serve(() => HttpResponse.json(RICH));
    renderPreview("[post](https://example.com/post)");
    keyboardFocus(screen.getByRole("link", { name: "post" }));
    const card = await screen.findByLabelText("Link preview");
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
    keyboardFocus(screen.getByRole("link", { name: "post" }));
    const card = await screen.findByLabelText("Link preview");
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
    keyboardFocus(screen.getByRole("link", { name: "post" }));
    keyboardFocus(screen.getByRole("link", { name: "local" }));
    hover(screen.getByRole("link", { name: "post" }));
    expect(screen.getByRole("link", { name: "local" })).not.toHaveAttribute("target");
    // Past the 200 ms open delay, so an opened card would have had time to fetch.
    await new Promise((resolve) => setTimeout(resolve, 300));
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
