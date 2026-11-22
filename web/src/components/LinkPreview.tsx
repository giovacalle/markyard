import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import {
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { fetchLinkPreview, type LinkPreviewData } from "../api";
import { safeImageSrc } from "../safeUrl";
import { useSettings } from "../settings";
import { useOnlineStatus } from "../useOnlineStatus";
import { GlobeIcon } from "./icons";

const OPEN_DELAY_MS = 200;
const CLOSE_DELAY_MS = 150;
/** Gap between the link and its card, and the card's minimum distance from the viewport edge. */
const GAP_PX = 8;

// Disabled stand-in for renders outside a QueryClientProvider (standalone Preview tests, rich
// copy): its queries never run.
let detachedClient: QueryClient | null = null;
function detached(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

export function linkPreviewKey(url: string) {
  return ["link-preview", url] as const;
}

/**
 * Metadata for an external `url` from `GET /api/link-preview`. Only fetched while `enabled`,
 * online, and inside a QueryClientProvider; cached for 30 minutes and never retried.
 */
export function useLinkPreview(url: string, { enabled }: { enabled: boolean }) {
  const client = useContext(QueryClientContext);
  const online = useOnlineStatus();
  const active =
    enabled &&
    client !== undefined &&
    online &&
    (typeof navigator === "undefined" || navigator.onLine !== false);
  return useQuery(
    {
      queryKey: linkPreviewKey(url),
      queryFn: ({ signal }) => fetchLinkPreview(url, signal),
      enabled: active,
      staleTime: 30 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      retry: false,
      refetchOnWindowFocus: false,
    },
    client ?? detached(),
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Whether `preview` says more than the URL itself. */
function isRich(preview: LinkPreviewData | undefined): preview is LinkPreviewData {
  return Boolean(preview?.title?.trim() || preview?.description?.trim());
}

/** A same-origin image that disappears when it cannot load. */
function OptionalImage({ src, className }: { src: string | undefined; className: string }) {
  const safe = safeImageSrc(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (safe === null || failedSrc === safe) {
    return null;
  }
  return (
    <img
      src={safe}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(safe)}
      className={className}
    />
  );
}

function SiteRow({ preview, url }: { preview: LinkPreviewData | undefined; url: string }) {
  const favicon = safeImageSrc(preview?.favicon);
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null);
  const label = preview?.siteName?.trim() || preview?.hostname || hostnameOf(url);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
      {favicon !== null && failedFavicon !== favicon ? (
        <img
          src={favicon}
          alt=""
          data-testid="link-favicon"
          onError={() => setFailedFavicon(favicon)}
          className="size-3.5 shrink-0 rounded-sm"
        />
      ) : (
        <GlobeIcon data-testid="link-globe" className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

/** The floating card shown for a hovered or focused external link. */
function PreviewCard({
  id,
  url,
  anchor,
  preview,
  loading,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  url: string;
  anchor: HTMLElement;
  preview: LinkPreviewData | undefined;
  loading: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const rich = isRich(preview);

  // Positioned through the CSSOM: the CSP forbids inline style attributes, not `element.style`.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    const link = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const below = link.bottom + GAP_PX;
    const above = link.top - GAP_PX - height;
    const top = below + height > viewportHeight - GAP_PX && above >= GAP_PX ? above : below;
    const maxLeft = Math.max(GAP_PX, viewportWidth - width - GAP_PX);
    const left = Math.min(Math.max(link.left, GAP_PX), maxLeft);
    card.style.setProperty("left", `${Math.round(left)}px`);
    card.style.setProperty("top", `${Math.round(top)}px`);
  });

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      aria-label="Link preview"
      aria-busy={loading || undefined}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className="fixed top-0 left-0 z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-neutral-200 bg-white text-left shadow-xl shadow-neutral-950/10 dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-black/40"
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        tabIndex={-1}
        onClick={stopPropagation}
        className="block text-neutral-900 no-underline dark:text-neutral-100"
      >
        {loading ? (
          <span data-testid="link-preview-loading" className="block space-y-2 p-3">
            <span className="block h-3 w-1/3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
            <span className="block h-3.5 w-4/5 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
            <span className="block h-3 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-800/70" />
          </span>
        ) : (
          <>
            {rich && (
              <OptionalImage
                src={preview.image}
                className="aspect-[1.91/1] w-full border-b border-neutral-200 bg-neutral-100 object-cover dark:border-neutral-800 dark:bg-neutral-800"
              />
            )}
            <span className="block space-y-1 p-3">
              <SiteRow preview={preview} url={url} />
              {rich && preview.title?.trim() && (
                <span className="line-clamp-2 block text-sm leading-snug font-semibold">
                  {preview.title}
                </span>
              )}
              {rich && preview.description?.trim() && (
                <span className="line-clamp-2 block text-xs leading-snug text-neutral-600 dark:text-neutral-400">
                  {preview.description}
                </span>
              )}
              <span className="block truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                {displayUrl(preview?.finalUrl ?? url)}
              </span>
            </span>
          </>
        )}
      </a>
    </div>,
    document.body,
  );
}

type ExternalLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  children?: ReactNode;
};

/**
 * An external Preview link: opens in a new tab and, unless link previews are off in Settings,
 * shows a preview card after a short hover or on keyboard focus.
 */
export function ExternalLink({ onClick, ...props }: ExternalLinkProps) {
  const { linkPreviewsEnabled } = useSettings();
  if (linkPreviewsEnabled) {
    return <PreviewingExternalLink {...props} onClick={onClick} />;
  }
  return (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    />
  );
}

/** The card stays open while the pointer moves onto it. */
function PreviewingExternalLink({
  href,
  children,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: ExternalLinkProps) {
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const cardId = useId();
  const query = useLinkPreview(href, { enabled: requested });
  const loading = query.data === undefined && query.fetchStatus === "fetching";

  const clearTimers = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  const show = () => {
    clearTimers();
    setRequested(true);
    setOpen(true);
  };
  const close = () => {
    clearTimers();
    setOpen(false);
  };
  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = window.setTimeout(show, OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onScroll = () => close();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Nothing to say beyond the link's own text: a failed fetch shows only the hostname card.
  const showCard = open && anchorRef.current !== null;

  return (
    <>
      <a
        {...props}
        ref={anchorRef}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={showCard ? cardId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          close();
          onClick?.(event);
        }}
        onMouseEnter={(event: MouseEvent<HTMLAnchorElement>) => {
          scheduleOpen();
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event: MouseEvent<HTMLAnchorElement>) => {
          scheduleClose();
          onMouseLeave?.(event);
        }}
        onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
          show();
          onFocus?.(event);
        }}
        onBlur={(event: FocusEvent<HTMLAnchorElement>) => {
          scheduleClose();
          onBlur?.(event);
        }}
      >
        {children}
      </a>
      {showCard && anchorRef.current !== null && (
        <PreviewCard
          id={cardId}
          url={href}
          anchor={anchorRef.current}
          preview={query.data}
          loading={loading}
          onPointerEnter={() => window.clearTimeout(closeTimer.current)}
          onPointerLeave={scheduleClose}
        />
      )}
    </>
  );
}

/**
 * A paragraph holding only a bare URL: becomes a bookmark card once the page's metadata loads
 * with a title or description; renders `children` (the plain link paragraph) until then, offline,
 * or when the preview fails. With link previews off in Settings, always the plain paragraph.
 */
export function BareUrlBookmark({ url, children }: { url: string; children: ReactNode }) {
  const { linkPreviewsEnabled } = useSettings();
  return linkPreviewsEnabled ? <Bookmark url={url}>{children}</Bookmark> : <>{children}</>;
}

function Bookmark({ url, children }: { url: string; children: ReactNode }) {
  const { data } = useLinkPreview(url, { enabled: true });
  if (!isRich(data)) {
    return <>{children}</>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopPropagation}
      aria-label={data.title?.trim() || data.hostname}
      data-testid="link-bookmark"
      className="flex min-h-24 overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 no-underline transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/70"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        {data.title?.trim() && (
          <span className="line-clamp-2 text-sm leading-snug font-semibold">{data.title}</span>
        )}
        {data.description?.trim() && (
          <span className="line-clamp-2 text-xs leading-snug text-neutral-600 dark:text-neutral-400">
            {data.description}
          </span>
        )}
        <span className="mt-auto pt-1">
          <SiteRow preview={data} url={url} />
        </span>
      </span>
      <OptionalImage
        src={data.image}
        className="w-28 shrink-0 border-l border-neutral-200 bg-neutral-100 object-cover sm:w-40 dark:border-neutral-800 dark:bg-neutral-800"
      />
    </a>
  );
}
