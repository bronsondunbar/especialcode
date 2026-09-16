import { useState } from "react";
import { ChevronRightIcon, TriangleIcon } from "lucide-react";
import { createVercelAtoms } from "@t3tools/client-runtime/state/vercel";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { VercelDialog } from "./VercelPanel";

const atoms = createVercelAtoms(connectionAtomRuntime);

/** Mounted only beneath the active server thread; checking its link never calls Vercel. */
export function VercelThreadTab(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const supported =
    environments.find((environment) => environment.environmentId === props.environmentId)
      ?.serverConfig?.environment.capabilities.vercel === true;
  const query = useEnvironmentQuery(
    supported
      ? atoms.sidebarConfiguration({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, threadId: props.threadId, configurationOnly: true },
        })
      : null,
  );
  if (!supported || !query.data?.connection) return null;
  const label = query.data.link ? "Vercel deployments" : "Link Vercel project";

  return (
    <div className="mb-1 ml-4 mt-1 border-l border-sidebar-border pl-2" data-thread-selection-safe>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-sidebar-foreground/75 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <TriangleIcon aria-hidden className="size-3 shrink-0 fill-current" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
      </button>
      {open && (
        <VercelDialog
          {...props}
          onClose={() => {
            setOpen(false);
            query.refresh();
          }}
        />
      )}
    </div>
  );
}
