import { useState } from "react";
import type { EnvironmentId, WorkItemId } from "@t3tools/contracts";
import { WorkPlanPanel } from "./WorkPlanPanel";
import { Button } from "../ui/button";

export function WorkAgentActions({
  executionSupported,
  environmentId,
  id,
}: {
  executionSupported: boolean;
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const [action, setAction] = useState<"plan" | "execute" | null>(null);
  if (action)
    return (
      <WorkPlanPanel
        inline
        environmentId={environmentId}
        id={id}
        initialAction={action}
        executionSupported={executionSupported}
        onClose={() => setAction(null)}
      />
    );
  return (
    <div
      role="group"
      aria-label="Agent action"
      className="flex w-full gap-1 rounded-lg border bg-input/40 p-1"
    >
      <Button
        type="button"
        variant="ghost"
        className="flex-1 hover:bg-background hover:shadow-sm"
        onClick={() => setAction("plan")}
      >
        Plan
      </Button>
      {executionSupported && (
        <Button
          type="button"
          variant="ghost"
          className="flex-1 hover:bg-background hover:shadow-sm"
          onClick={() => setAction("execute")}
        >
          Execute
        </Button>
      )}
    </div>
  );
}
