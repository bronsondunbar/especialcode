import { useState } from "react";
import { Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironments } from "../../state/environments";
import { composerDraftsAtom, updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { ControlPill } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";
import { VercelProjectField } from "./VercelProjectField";
export function VercelDraftButton({
  environmentId,
  projectId,
  draftKey,
  disabled,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftKey: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const drafts = useAtomValue(composerDraftsAtom);
  if (
    !environments.find((env) => env.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.vercel
  )
    return null;
  return (
    <>
      <ControlPill label="Vercel" disabled={disabled} onPress={() => setOpen(true)} />
      {open && (
        <Modal visible animationType="slide" onRequestClose={() => setOpen(false)}>
          <SafeAreaView className="flex-1 bg-background">
            <ScrollView contentContainerClassName="gap-4 p-4" keyboardShouldPersistTaps="handled">
              <Text className="text-xl font-semibold">Link Vercel project</Text>
              <VercelProjectField
                key={`${environmentId}:${projectId}`}
                environmentId={environmentId}
                projectId={projectId}
                value={drafts[draftKey]?.vercel ?? undefined}
                onChange={(value) =>
                  updateComposerDraftSettings(draftKey, { vercel: value ?? null })
                }
                disabled={disabled}
              />
              <ControlPill label="Done" onPress={() => setOpen(false)} />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}
    </>
  );
}
