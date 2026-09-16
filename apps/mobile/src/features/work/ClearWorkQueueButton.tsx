import { useState } from "react";
import { Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Cause from "effect/Cause";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  createWorkItemAtoms,
  clearWorkQueueDescription,
  type WorkQueueClearPreview,
} from "@t3tools/client-runtime/state/work-items";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
const atoms = createWorkItemAtoms(connectionAtomRuntime);
const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "Could not clear the queue. Try again.";
};
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
  const prepare = useAtomCommand(atoms.previewClear, { reportFailure: false });
  const clear = useAtomCommand(atoms.clear, { reportFailure: false });
  async function prepareClear() {
    setPending(true);
    setMessage(null);
    try {
      const result = await prepare({ environmentId, input: { archived } });
      if (result._tag === "Success") setPreview(result.value);
      else setMessage(errorMessage(result.cause));
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
        input: { preview, archived, commandId: uuidv4() },
      });
      if (result._tag === "Success") {
        setMessage(
          `${archived ? "Deleted" : "Archived"} ${result.value.cleared} tasks.${result.value.error ? ` ${result.value.error} Review the queue and try again to clear the remaining tasks.` : archived ? "" : " Restore them from Archived whenever needed."}`,
        );
      } else setMessage(errorMessage(result.cause));
      setPreview(null);
      onCleared();
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="gap-2">
      <ControlPill
        disabled={pending}
        label={pending ? "Please wait…" : archived ? "Clear archived tasks" : "Clear work queue"}
        onPress={() => void prepareClear()}
      />
      {message && (
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
          {message}
        </Text>
      )}
      {preview && (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => {
            if (!pending) setPreview(null);
          }}
        >
          <SafeAreaView className="flex-1 justify-center gap-4 bg-background p-6">
            <Text className="text-xl font-semibold">
              {archived ? "Clear archived tasks?" : "Clear work queue?"}
            </Text>
            <Text>{clearWorkQueueDescription(preview, archived)}</Text>
            <ControlPill
              disabled={pending || !preview.tasks.length}
              label={
                pending
                  ? "Clearing…"
                  : `${archived ? "Delete" : "Archive"} ${preview.tasks.length} tasks`
              }
              onPress={() => void confirmClear()}
            />
            <ControlPill disabled={pending} label="Cancel" onPress={() => setPreview(null)} />
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}
