import { useRef, useState } from "react";
import { View } from "react-native";
import * as Cause from "effect/Cause";
import { createWorkReviewAtoms } from "@t3tools/client-runtime/state/work-items";
import type { EnvironmentId, WorkItemId, WorkReviewMutation } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
const atoms = createWorkReviewAtoms(connectionAtomRuntime);
export function WorkReviewPanel({
  environmentId,
  id,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const query = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [draft, setDraft] = useState<{
    workRevision: number;
    reviewRevision: number;
    guidance: string;
    commands: string;
  } | null>(null);
  const retry = useRef<{ key: string; commandId: string } | null>(null);
  const data = query.data;
  const snapshot = data?.snapshot;
  const active =
    data?.execution && !["succeeded", "failed", "stopped"].includes(data.execution.status);
  async function send(input: WorkReviewMutation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = Cause.squash(result.cause);
        setError(cause instanceof Error ? cause.message : "Review update failed.");
      } else {
        setDraft(null);
        retry.current = null;
        query.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function start() {
    if (!draft) return;
    const key = JSON.stringify(draft);
    const commandId = retry.current?.key === key ? retry.current.commandId : uuidv4();
    retry.current = { key, commandId };
    void send({
      kind: "send",
      id,
      commandId,
      expectedWorkItemRevision: draft.workRevision,
      expectedReviewRevision: draft.reviewRevision,
      guidance: draft.guidance,
      validationCommands: draft.commands
        .split("\n")
        .map((command) => command.trim())
        .filter(Boolean),
    });
  }
  if (
    data &&
    !snapshot &&
    !data.history.length &&
    !["review", "blocked"].includes(data.item.status)
  )
    return null;
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold">Review feedback</Text>
      {(error || query.error || data?.syncError) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error ?? data?.syncError}
        </Text>
      )}
      <ControlPill
        label="Refresh review feedback"
        disabled={pending}
        onPress={() => void send({ kind: "refresh", id })}
      />
      {snapshot && (
        <Text>
          PR {snapshot.state} · {snapshot.reviewDecision ?? "No review decision"} · Synced{" "}
          {new Date(snapshot.syncedAt).toLocaleString()}
        </Text>
      )}
      {data?.execution?.review && (
        <Text>
          Review cycle: {data.execution.status} · {data.execution.activity}
        </Text>
      )}
      {data?.item.status === "done" && data.item.completedAt && (
        <Text>Completed {new Date(data.item.completedAt).toLocaleString()}</Text>
      )}
      {snapshot?.state === "open" &&
        data &&
        ["review", "blocked"].includes(data.item.status) &&
        !active && (
          <>
            {draft ? (
              <>
                <Text className="text-sm text-muted-foreground">
                  This resumes the original agent thread with saved review comments and failed
                  checks, validates its fixes, then commits and pushes to the same PR. Review the PR
                  comments before confirming.
                </Text>
                <Text>Additional guidance</Text>
                <TextInput
                  accessibilityLabel="Additional guidance"
                  className="rounded-lg border border-border p-3 text-foreground"
                  multiline
                  editable={!pending}
                  maxLength={5000}
                  value={draft.guidance}
                  onChangeText={(guidance) => setDraft({ ...draft, guidance })}
                />
                <Text>Required validation commands</Text>
                <TextInput
                  accessibilityLabel="Required validation commands"
                  className="rounded-lg border border-border p-3 text-foreground"
                  multiline
                  editable={!pending}
                  value={draft.commands}
                  onChangeText={(commands) => setDraft({ ...draft, commands })}
                />
                <ControlPill
                  label="Resume Agent, Validate & Push"
                  disabled={pending || !draft.commands.trim()}
                  onPress={start}
                />
                <ControlPill label="Cancel" disabled={pending} onPress={() => setDraft(null)} />
              </>
            ) : (
              <ControlPill
                label="Send Changes to Agent"
                disabled={pending || snapshot.commentsTruncated}
                onPress={() =>
                  setDraft({
                    workRevision: data.item.revision,
                    reviewRevision: snapshot.revision,
                    guidance: "",
                    commands: data.execution?.validationCommands.join("\n") ?? "",
                  })
                }
              />
            )}
            {snapshot.commentsTruncated && (
              <Text>
                The host returned incomplete comments. Open the PR before starting a review cycle.
              </Text>
            )}
          </>
        )}
      {data && data.history.length > 0 && (
        <>
          <ControlPill
            label={`${history ? "Hide" : "Show"} WorkItem activity`}
            onPress={() => setHistory(!history)}
          />
          {history &&
            data.history.map((event) => (
              <View key={event.id} className="gap-1">
                <Text className="text-xs text-muted-foreground">
                  {new Date(event.occurredAt).toLocaleString()}
                </Text>
                <Text selectable>{event.message}</Text>
              </View>
            ))}
        </>
      )}
    </View>
  );
}
