import { frontmatterTags, isTagKey, type Frontmatter } from "../frontmatter";

/** Collapsible chip bar for a note's frontmatter; the raw YAML in the file is never touched. */
export function PropertiesBar({
  frontmatter,
  onTagClick,
}: {
  frontmatter: Frontmatter;
  onTagClick?: (tag: string) => void;
}) {
  if (frontmatter.properties.length === 0) {
    return null;
  }
  const tags = frontmatterTags(frontmatter);
  const others = frontmatter.properties.filter((p) => !isTagKey(p.key));

  return (
    <details
      aria-label="Properties"
      className="group rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
        <span className="font-medium">Properties</span>
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            title={`Search notes tagged #${tag}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTagClick?.(tag);
            }}
            className="cursor-pointer rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 transition-colors hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/70"
          >
            #{tag}
          </button>
        ))}
      </summary>
      {others.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 pb-1">
          {others.map((p, index) => (
            <div key={`${p.key}-${index}`} className="contents">
              <dt className="text-neutral-500 dark:text-neutral-400">{p.key}</dt>
              <dd className="break-words text-neutral-800 dark:text-neutral-200">
                {Array.isArray(p.value) ? p.value.join(", ") : p.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
