import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { buttonVariants } from "../ui/button";

/** Mount supporting panels on first expansion, then retain their drafts when collapsed. */
export function WorkDetails({
  title,
  action = false,
  children,
}: {
  title: string;
  action?: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  return (
    <details
      className="group/work-details"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <summary
        className={
          action
            ? buttonVariants({
                variant: "outline",
                className: "w-fit list-none [&::-webkit-details-marker]:hidden",
              })
            : "flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
        }
      >
        <ChevronRightIcon aria-hidden className="size-4 group-open/work-details:rotate-90" />
        {title}
      </summary>
      {visited && <div className="mt-3 grid min-w-0 gap-4">{children}</div>}
    </details>
  );
}
