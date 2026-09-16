import { useState } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { VercelProjectField } from "./VercelProjectField";
export function VercelDraftButton({
  environmentId,
  projectId,
  draftId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftId: DraftId;
}) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  if (
    !environments.find((env) => env.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.vercel
  )
    return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Vercel
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogPopup className="p-6">
            <DialogTitle>Link Vercel project</DialogTitle>
            <div className="mt-4">
              <VercelProjectField
                key={`${environmentId}:${projectId}`}
                environmentId={environmentId}
                projectId={projectId}
                value={draft?.vercel ?? undefined}
                onChange={(value) =>
                  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
                    vercel: value ?? null,
                    ...(value
                      ? {
                          projectRef: scopeProjectRef(environmentId, projectId),
                          environmentSelection: "manual" as const,
                        }
                      : {}),
                  })
                }
              />
            </div>
            <Button className="mt-4" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}
