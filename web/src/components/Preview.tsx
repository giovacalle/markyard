import {
  type ComponentPropsWithoutRef,
  type ComponentType,
  createContext,
  type ReactNode,
  type SVGProps,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { normalizeFrontmatterFence } from "../frontmatter";
import { usePkm } from "../pkm";
import { isExternalHref, safeImageSrc } from "../safeUrl";
import { CALLOUT_LABELS, type CalloutType, remarkCallouts } from "../remarkCallouts";
import { remarkWikilinks } from "../remarkWikilinks";
import { toggleTaskAt } from "../taskToggle";
import { resolveWikilink } from "../wikilinks";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  MessageAlertIcon,
  OctagonAlertIcon,
} from "./icons";
import { BareUrlBookmark, ExternalLink } from "./LinkPreview";
import { hasQueryFence } from "../queryFormat";
import { QueryBlock, QueryVaultDocumentsProvider } from "./QueryBlock";

type PluginList = NonNullable<ComponentPropsWithoutRef<typeof Markdown>["remarkPlugins"]>;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number } };
  children?: HastNode[];
}

interface LazyModule<T> {
  loaded: T | null;
  load: () => Promise<T>;
}

function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let pending: Promise<T> | null = null;
  const module: LazyModule<T> = {
    loaded: null,
    load: () => {
      pending ??= importer().then(
        (value) => {
          module.loaded = value;
          return value;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
  };
  return module;
}

const MATH = lazyModule(() => import("../mathPlugins"));
const HIGHLIGHT = lazyModule(() => import("../highlightPlugin"));

/** Loads `module` the first time `needed` turns true; renders without it until then. */
function useLazyModule<T>(needed: boolean, module: LazyModule<T>): T | null {
  const [value, setValue] = useState<T | null>(module.loaded);
  useEffect(() => {
    if (!needed || value !== null) {
      return;
    }
    let active = true;
    module.load().then(
      (loaded) => active && setValue(loaded),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [needed, value, module]);
  return needed ? value : null;
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function stripCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null && marker !== undefined) {
      fence = marker;
    } else if (fence !== null && marker?.[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    } else if (fence === null) {
      kept.push(line.replace(/`+[^`]*`+/g, ""));
    }
  }
  return kept.join("\n");
}

function hasFence(text: string): boolean {
  return /^[ \t]{0,3}(`{3,}|~{3,})/m.test(text);
}

function PreviewQueryBlock({ source }: { source: string }) {
  const { onToggleTask } = useContext(PreviewContext);
  return <QueryBlock source={source} onToggleTask={onToggleTask} />;
}

function hasMath(text: string): boolean {
  return /\$\$[\s\S]*?\$\$|\$[^\s$](?:[^$\n]*[^\s$])?\$/.test(stripCode(text));
}

function hastText(node: HastNode, skipLists = false): string {
  if (node.type === "text") return node.value ?? "";
  if (skipLists && (node.tagName === "ul" || node.tagName === "ol")) return "";
  return (node.children ?? []).map((child) => hastText(child, skipLists)).join("");
}

const PreviewContext = createContext<{
  text: string;
  onToggleTask?: (nextText: string) => void;
}>({ text: "" });

const TaskItemContext = createContext<{ label: string; offset?: number } | undefined>(undefined);

function TaskInput({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"input"> & { node?: unknown }) {
  const task = useContext(TaskItemContext);
  const { text, onToggleTask } = useContext(PreviewContext);
  if (props.type !== "checkbox") {
    return <input {...props} />;
  }
  const offset = task?.offset;
  const interactive = onToggleTask !== undefined && offset !== undefined;
  return (
    <input
      {...props}
      aria-label={task?.label ?? "Task item"}
      disabled={!interactive}
      onClick={(event) => event.stopPropagation()}
      onChange={() => {
        // micromark drops a leading BOM, so its offsets are one short of the raw text.
        const bom = text.startsWith("\uFEFF") ? 1 : 0;
        const next = interactive ? toggleTaskAt(text, offset + bom) : null;
        if (next !== null) {
          onToggleTask?.(next);
        }
      }}
    />
  );
}

/** A `[[wikilink]]`: opens the note it resolves to, or creates it when it does not exist yet. */
function Wikilink({
  target,
  heading,
  children,
}: {
  target?: string;
  heading?: string;
  children?: ReactNode;
}) {
  const pkm = usePkm();
  if (pkm === null) {
    return <span className="wikilink">{children}</span>;
  }
  const linkHeading = heading || undefined;
  const current = pkm.notes.find((note) => note.id === pkm.currentFileId);
  const resolved = target ? resolveWikilink(target, pkm.notes, current?.path) : (current ?? null);
  if (resolved === null) {
    const stem = (target ?? "").split("/").at(-1)?.trim() ?? "";
    return (
      <button
        type="button"
        className="wikilink wikilink-unresolved"
        title={`Create note “${stem}”`}
        onClick={(event) => {
          event.stopPropagation();
          if (stem.length > 0) {
            pkm.createNote(stem);
          }
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <a
      href={`/?file=${encodeURIComponent(resolved.id)}`}
      className="wikilink"
      data-note-id={resolved.id}
      onClick={(event) => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        pkm.openNote(resolved.id, { heading: linkHeading });
      }}
    >
      {children}
    </a>
  );
}

export { safeImageSrc };

/**
 * The URL of a paragraph holding nothing but one bare, autolinked `http(s)://` URL (pasted on its
 * own line), or `null`. Labeled links such as `[Example](https://example.com)` do not count.
 */
export function bareUrlOf(paragraph: HastNode | undefined): string | null {
  const children = (paragraph?.children ?? []).filter(
    (child) => !(child.type === "text" && (child.value ?? "").trim() === ""),
  );
  const link = children[0];
  if (children.length !== 1 || link.type !== "element" || link.tagName !== "a") {
    return null;
  }
  const href = link.properties?.href;
  if (!isExternalHref(href)) {
    return null;
  }
  const label = hastText(link).trim();
  return label === href || `${label}/` === href || label === `${href}/` ? href : null;
}

function MarkdownImage({ src, alt, title }: { src?: unknown; alt?: string; title?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const label = alt ?? "";
  const safe = safeImageSrc(src);
  const hasSource = typeof src === "string" && src.trim().length > 0;
  if (safe === null || failedSrc === safe) {
    const reason = safe !== null ? "Image unavailable: " : hasSource ? "Image blocked: " : "";
    return (
      <span
        role="img"
        aria-label={label || "Image"}
        title={title}
        className="markdown-image-fallback"
      >
        {reason}
        {label || "image"}
      </span>
    );
  }
  return (
    <img
      src={safe}
      alt={label}
      title={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(safe)}
      className="markdown-image h-auto max-w-full rounded-lg border border-neutral-200 dark:border-neutral-800"
    />
  );
}

const CALLOUT_ICONS: Record<CalloutType, ComponentType<SVGProps<SVGSVGElement>>> = {
  note: InfoIcon,
  tip: LightbulbIcon,
  important: MessageAlertIcon,
  warning: AlertTriangleIcon,
  caution: OctagonAlertIcon,
};

function Callout({
  type,
  title,
  className,
  children,
}: {
  type: CalloutType;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const Icon = CALLOUT_ICONS[type];
  return (
    <div role="note" aria-label={title} className={className}>
      <p className="callout-title">
        <Icon className="size-4 shrink-0" />
        <span>{title}</span>
      </p>
      {children}
    </div>
  );
}

function CodeBlock({
  language,
  code,
  children,
}: {
  language?: string;
  code: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <figure aria-label={language ? `${language} code` : "Code"} className="code-block">
      <figcaption className="code-block-header">
        <span className="code-block-language">{language ?? ""}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          title="Copy code"
          className="code-block-copy"
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => undefined,
            );
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      {children}
    </figure>
  );
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function useIsDark(): boolean {
  return useSyncExternalStore(subscribeToTheme, () =>
    document.documentElement.classList.contains("dark"),
  );
}

function MermaidBlock({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dark = useIsDark();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    setFailed(false);
    import("../mermaidRender")
      .then((m) => m.renderMermaidInto(host, source, dark))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [source, dark]);

  return (
    <>
      <div
        ref={hostRef}
        role="img"
        aria-label="Mermaid diagram"
        hidden={failed}
        className="mermaid-diagram"
      />
      {failed && (
        <div role="alert" className="mermaid-error">
          <p>Unable to render this diagram.</p>
          <pre>
            <code>{source}</code>
          </pre>
        </div>
      )}
    </>
  );
}

function codeLanguage(code: HastNode): string | undefined {
  const className = code.properties?.className;
  const classes = Array.isArray(className) ? className : [];
  const language = classes.find(
    (name): name is string => typeof name === "string" && name.startsWith("language-"),
  );
  return language?.slice("language-".length);
}

const MARKDOWN_COMPONENTS = {
  wikilink: ({
    node: _node,
    ...props
  }: {
    node?: unknown;
    target?: string;
    heading?: string;
    children?: ReactNode;
  }) => <Wikilink {...props} />,
  h1: ({ node: _node, ...props }) => <h3 {...props} />,
  h2: ({ node: _node, ...props }) => <h4 {...props} />,
  h3: ({ node: _node, ...props }) => <h5 {...props} />,
  h4: ({ node: _node, ...props }) => <h6 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  h6: ({ node: _node, ...props }) => <h6 {...props} />,
  li: ({ node, className, children, ...props }) => {
    const isTask =
      typeof className === "string" && className.split(/\s+/).includes("task-list-item");
    const hast = node as HastNode | undefined;
    const task = isTask
      ? {
          label: (hast ? hastText(hast, true).trim() : "") || "Task item",
          offset: hast?.position?.start.offset,
        }
      : undefined;
    return (
      <TaskItemContext.Provider value={task}>
        <li className={className} {...props}>
          {children}
        </li>
      </TaskItemContext.Provider>
    );
  },
  input: TaskInput,
  a: ({ node: _node, href, children, ...props }) =>
    isExternalHref(href) ? (
      <ExternalLink {...props} href={href}>
        {children}
      </ExternalLink>
    ) : (
      <a {...props} href={href}>
        {children}
      </a>
    ),
  p: ({ node, children, ...props }) => {
    const url = bareUrlOf(node as HastNode | undefined);
    const paragraph = <p {...props}>{children}</p>;
    return url === null ? paragraph : <BareUrlBookmark url={url}>{paragraph}</BareUrlBookmark>;
  },
  img: ({ node: _node, src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} />,
  div: ({ node: _node, children, ...props }) => {
    const type = (props as Record<string, unknown>)["data-callout"];
    const title = (props as Record<string, unknown>)["data-callout-title"];
    if (typeof type === "string" && Object.hasOwn(CALLOUT_LABELS, type)) {
      return (
        <Callout type={type as CalloutType} title={String(title)} className={props.className}>
          {children}
        </Callout>
      );
    }
    return <div {...props}>{children}</div>;
  },
  pre: ({ node, children, ...props }) => {
    const code = (node as HastNode | undefined)?.children?.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    if (code === undefined) {
      return <pre {...props}>{children}</pre>;
    }
    const language = codeLanguage(code);
    const raw = hastText(code).replace(/\r?\n$/, "");
    if (language === "mermaid") {
      return <MermaidBlock source={raw} />;
    }
    if (language?.toLowerCase() === "query") {
      return <PreviewQueryBlock source={raw} />;
    }
    return (
      <CodeBlock language={language} code={raw}>
        <pre {...props}>{children}</pre>
      </CodeBlock>
    );
  },
} as Components;

const HIGHLIGHT_OPTIONS = {
  detect: false,
  plainText: ["mermaid", "query", "math", "text", "txt"],
};

export function Preview({
  text,
  onToggleTask,
}: {
  text: string;
  /** Receives the whole note with one task checkbox flipped; omit to keep checkboxes disabled. */
  onToggleTask?: (nextText: string) => void;
}) {
  const markdown = useMemo(() => normalizeFrontmatterFence(text), [text]);
  const math = useLazyModule(
    useMemo(() => hasMath(markdown), [markdown]),
    MATH,
  );
  const highlight = useLazyModule(hasFence(markdown), HIGHLIGHT);
  const context = useMemo(() => ({ text, onToggleTask }), [text, onToggleTask]);

  const remarkPlugins = useMemo<PluginList>(
    () => [
      remarkFrontmatter,
      remarkGfm,
      ...(math ? [math.remarkMath] : []),
      remarkCallouts,
      remarkWikilinks,
    ],
    [math],
  );
  const rehypePlugins = useMemo<PluginList>(
    () =>
      [
        ...(math ? [math.rehypeKatex] : []),
        ...(highlight ? [[highlight.rehypeHighlight, HIGHLIGHT_OPTIONS] as const] : []),
      ] as PluginList,
    [math, highlight],
  );

  const hasQueries = useMemo(() => hasQueryFence(markdown), [markdown]);
  const rendered = (
    <div className="markdown-preview">
      <Markdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
      >
        {markdown}
      </Markdown>
    </div>
  );

  return (
    <PreviewContext.Provider value={context}>
      {hasQueries ? (
        <QueryVaultDocumentsProvider>{rendered}</QueryVaultDocumentsProvider>
      ) : (
        rendered
      )}
    </PreviewContext.Provider>
  );
}
