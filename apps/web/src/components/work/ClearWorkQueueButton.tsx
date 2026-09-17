import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  clearWorkQueueDescription,
  type WorkQueueClearPreview,
} from "@t3tools/client-runtime/state/work-items";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { workItems } from "../../state/workItems";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

export function ClearWorkQueueButton({
  environmentId,
  onCleared,
  archived = false,
}: {
  environmentId: EnvironmentId;
  onCleared: () => void;
  archived?: boolean;
}) {
  const [preview, setPreview] = useState<WorkQueueClearPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const prepare = useAtomCommand(workItems.previewClear, { reportFailure: false });
  const clear = useAtomCommand(workItems.clear, { reportFailure: false });
  async function prepareClear() {
    setPending(true);
    setMessage(null);
    try {
      const result = await prepare({ environmentId, input: { archived } });
      if (result._tag === "Success") setPreview(result.value);
      else setMessage(formatEnvironmentQueryError(result.cause));
    } finally {
      setPending(false);
    }
  }
  async function confirmClear() {
    if (!preview || pending) return;
    setPending(true);
    try {
      const result = await clear({
        environmentId,
        input: { preview, archived, commandId: randomUUID() },
      });
      if (result._tag === "Success") {
        setMessage(
          `${archived ? "Deleted" : "Archived"} ${result.value.cleared} tasks.${result.value.error ? ` ${result.value.error} Review the queue and try again to clear the remaining tasks.` : archived ? "" : " Restore them from Archived whenever needed."}`,
        );
      } else setMessage(formatEnvironmentQueryError(result.cause));
      setPreview(null);
      onCleared();
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="outline" disabled={pending} onClick={() => void prepareClear()}>
        {pending ? "Please wait…" : archived ? "Clear archived tasks" : "Clear queue"}
      </Button>
      {message && (
        <p role="status" className="max-w-md text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setPreview(null);
          }}
        >
          <DialogPopup className="p-6">
            <DialogTitle>{archived ? "Clear archived tasks?" : "Clear queue?"}</DialogTitle>
            <p className="my-4 text-sm text-muted-foreground">
              {clearWorkQueueDescription(preview, archived)}
            </p>
            <div className="flex gap-2">
              <Button
                variant={archived ? "destructive" : "default"}
                disabled={pending || !preview.tasks.length}
                onClick={() => void confirmClear()}
              >
                {pending
                  ? "Clearing…"
                  : `${archived ? "Delete" : "Archive"} ${preview.tasks.length} tasks`}
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
