import { useRef, useState } from "react";
import { Linking, Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Cause from "effect/Cause";
import { createWorkItemAtoms, workTaskUpdateDraft } from "@t3tools/client-runtime/state/work-items";
import type { EnvironmentId, ThreadId, WorkTaskUpdateInput } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
const atoms = createWorkItemAtoms(connectionAtomRuntime);
type Props = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messages: ReadonlyArray<{ role: string; text: string; streaming: boolean }>;
};
export function WorkTaskUpdateButton(props: Props) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  if (
    !environments.find((environment) => environment.environmentId === props.environmentId)
      ?.serverConfig?.environment.capabilities.workTaskUpdates
  )
    return null;
  return (
    <>
      <ComposerToolbarButton
        label="Draft update"
        className="rounded-xl border-border px-2"
        showChevron={false}
        onPress={() => setOpen(true)}
      />
      {open && <UpdateDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
function UpdateDialog({
  environmentId,
  threadId,
  messages,
  onClose,
}: Props & { onClose: () => void }) {
  const [draft] = useState(() => workTaskUpdateDraft(messages));
  const [body, setBody] = useState(draft.body);
  const query = useEnvironmentQuery(atoms.updateTargets({ environmentId, input: { threadId } }));
  const [selection, setSelection] = useState("");
  const targets = query.data ?? [];
  const target =
    targets.find((item) => `${item.taskId}:${item.source.key}` === selection) ?? targets[0];
  const post = useAtomCommand(atoms.postUpdate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<WorkTaskUpdateInput | null>(null);
  async function submit() {
    if (pending || url || !target || !body.trim()) return;
    setPending(true);
    setError(null);
    attempt.current ??= {
      taskId: target.taskId,
      threadId,
      sourceKey: target.source.key,
      body,
      commandId: uuidv4(),
    };
    try {
      const result = await post({ environmentId, input: attempt.current });
      if (result._tag === "Success") {
        setUrl(result.value.url);
        setUncertain(false);
      } else {
        const failure = Cause.squash(result.cause);
        const isUncertain = !(
          typeof failure === "object" &&
          failure !== null &&
          "uncertain" in failure &&
          failure.uncertain === false
        );
        setUncertain(isUncertain);
        if (!isUncertain) attempt.current = null;
        setError(
          failure instanceof Error
            ? failure.message
            : "Posting could not be confirmed. Check the original conversation.",
        );
      }
    } catch {
      setUncertain(true);
      setError(
        "Posting could not be confirmed. Check the original conversation before drafting another update.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!pending) onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-background">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
          <Text className="text-xl font-semibold">Review update</Text>
          <Text className="text-sm text-muted-foreground">
            Drafted from the latest completed agent response. Review the destination and edit the
            text before posting.
          </Text>
          {query.isPending && !query.data && <Text>Loading linked tasks…</Text>}
          {query.error && (
            <Text accessibilityRole="alert" className="text-destructive">
              {query.error}
            </Text>
          )}
          {query.data && !targets.length && (
            <Text>
              Link this thread to a Work task with a GitHub issue or Slack message to post an
              update.
            </Text>
          )}
          {target && (
            <>
              <ControlPillMenu
                title="Post to"
                actions={targets.map((item) => ({
                  id: `${item.taskId}:${item.source.key}`,
                  title: `${item.source.label} — ${item.taskTitle}`,
                }))}
                onPressAction={({ nativeEvent }) => {
                  if (!pending && !uncertain && !url) setSelection(nativeEvent.event);
                }}
              >
                <ControlPill
                  label={`Post to: ${target.source.label}`}
                  disabled={pending || uncertain || !!url}
                />
              </ControlPillMenu>
              <Text className="text-sm">{target.taskTitle}</Text>
              <Text
                className="text-sm underline"
                accessibilityRole="link"
                onPress={() => void Linking.openURL(target.source.url)}
              >
                {target.source.url}
              </Text>
              {draft.truncated && (
                <Text className="text-sm text-muted-foreground">
                  The response was shortened to 4,000 characters. Review it for completeness.
                </Text>
              )}
              <Text>Update</Text>
              <TextInput
                accessibilityLabel="Update"
                className="min-h-64 rounded-lg border border-border p-3 text-foreground"
                multiline
                textAlignVertical="top"
                value={body}
                maxLength={4000}
                editable={!pending && !uncertain && !url}
                onChangeText={setBody}
                placeholder="Describe what changed and any checks or remaining work."
              />
              <Text className="text-xs text-muted-foreground">
                {body.length}/4,000 ·{" "}
                {target.source.kind === "github"
                  ? "Posts a comment on this issue using this environment’s GitHub connection."
                  : "Replies in the original Slack thread using your connected account."}
              </Text>
            </>
          )}
          {error && (
            <Text accessibilityRole="alert" className="text-destructive">
              {error}
            </Text>
          )}
          {uncertain && (
            <Text>
              Check the source before starting another draft. Checking status will not resend this
              update.
            </Text>
          )}
          {url && (
            <Text
              accessibilityRole="link"
              className="underline"
              onPress={() => void Linking.openURL(url)}
            >
              Update posted. View posted update
            </Text>
          )}
          {!url && (
            <ControlPill
              disabled={pending || !target || !body.trim() || body.length > 4000}
              label={
                pending
                  ? "Posting…"
                  : uncertain
                    ? "Check posting status"
                    : target?.source.kind === "slack"
                      ? "Post Slack reply"
                      : "Post GitHub comment"
              }
              onPress={() => void submit()}
            />
          )}
          <ControlPill label={url ? "Done" : "Cancel"} disabled={pending} onPress={onClose} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
