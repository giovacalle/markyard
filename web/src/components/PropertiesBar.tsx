import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { isTagKey, type Frontmatter } from "../frontmatter";
import { ChevronIcon } from "./icons";

/** Collapsible properties bar for a note's frontmatter; the raw YAML in the file is never touched. */
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

  return (
    <Collapsible
      defaultOpen
      role="group"
      aria-label="Properties"
      className="group/properties rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-neutral-500 transition-colors hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:text-neutral-200">
        <ChevronIcon className="size-3.5 shrink-0 transition-transform group-data-open/properties:rotate-90" />
        <span className="font-medium">Properties</span>
      </CollapsibleTrigger>
      <CollapsiblePanel
        render={<dl />}
        className="mt-2 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5 border-t border-neutral-200/80 pt-2 pb-1 dark:border-neutral-800"
      >
        {frontmatter.properties.map((p, index) => {
          const isTags = isTagKey(p.key);
          const tagValues = isTags
            ? (Array.isArray(p.value) ? p.value : [p.value]).filter((tag) => tag.length > 0)
            : [];
          return (
            <div key={`${p.key}-${index}`} className="contents">
              <dt className="text-neutral-500 dark:text-neutral-400">{p.key}</dt>
              <dd className="min-w-0 break-words text-neutral-800 dark:text-neutral-200">
                {isTags && tagValues.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    {tagValues.map((tag, tagIndex) => (
                      <button
                        key={`${tag}-${tagIndex}`}
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
                  </div>
                ) : Array.isArray(p.value) ? (
                  p.value.join(", ")
                ) : (
                  p.value
                )}
              </dd>
            </div>
          );
        })}
      </CollapsiblePanel>
    </Collapsible>
  );
}
