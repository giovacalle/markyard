import type { Frontmatter } from "../frontmatter";

/** Collapsible chip bar for a note's frontmatter; the raw YAML in the file is never touched. */
export function PropertiesBar({ frontmatter }: { frontmatter: Frontmatter }) {
  if (frontmatter.properties.length === 0) {
    return null;
  }
  const tags = frontmatter.properties.filter((p) => /^(tags?|keywords)$/i.test(p.key));
  const others = frontmatter.properties.filter((p) => !tags.includes(p));

  return (
    <details
      aria-label="Properties"
      className="group rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
        <span className="font-medium">Properties</span>
        {tags
          .flatMap((p) => p.value)
          .filter((tag) => tag !== "")
          .map((tag, index) => (
            <span
              key={`${tag}-${index}`}
              className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
            >
              #{tag}
            </span>
          ))}
      </summary>
      {others.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 pb-1">
          {others.map((p) => (
            <div key={p.key} className="contents">
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
