import { useRef, type ReactNode } from "react";

export type OnRetry = (refetch: () => unknown) => void;

/**
 * Wraps every state of a retryable view (loading, error, loaded) in one focus target. Retry moves
 * focus there first, so focus does not fall to `<body>` when the Retry button unmounts
 * (WCAG 2.4.3).
 */
export function RetryScope({
  className,
  children,
}: {
  className?: string;
  children: (onRetry: OnRetry) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onRetry: OnRetry = (refetch) => {
    ref.current?.focus();
    void refetch();
  };
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={className ? `outline-none ${className}` : "outline-none"}
    >
      {children(onRetry)}
    </div>
  );
}
