import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import * as Cause from "effect/Cause";
import { createWorkPullRequestAtoms } from "@t3tools/client-runtime/state/work-items";
import type {
  EnvironmentId,
  WorkItemId,
  WorkPullRequestMutation,
  WorkPullRequestContent,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
const atoms = createWorkPullRequestAtoms(connectionAtomRuntime);
export function WorkPullRequestPanel({
  environmentId,
  id,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const query = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [draft, setDraft] = useState<typeof WorkPullRequestContent.Type | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<PullRequestMergeMethod | null>(null);
  const [comments, setComments] = useState(false);
  const retry = useRef<{ key: string; commandId: string } | null>(null);
  const data = query.data;
  async function send(input: WorkPullRequestMutation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = Cause.squash(result.cause);
        setError(cause instanceof Error ? cause.message : "Pull request operation failed.");
      } else {
        setDraft(null);
        setMerge(null);
        retry.current = null;
        query.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function create() {
    if (!data || !draft) return;
    const key = JSON.stringify({ draft, revision: draftRevision });
    const commandId = retry.current?.key === key ? retry.current.commandId : uuidv4();
    retry.current = { key, commandId };
    void send({
      kind: "create",
      id,
      commandId,
      expectedRevision: draftRevision,
      content: draft,
    });
  }
  const detail = data?.detail;
  const busy = pending || data?.record?.status === "creating";
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold">Pull request</Text>
      {(error || query.error || data?.refreshError || data?.record?.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error ?? data?.refreshError ?? data?.record?.error}
        </Text>
      )}
      {!data ? (
        <Text>Loading pull request…</Text>
      ) : data.record?.reference ? (
        <>
          <ControlPill
            label={`Open PR #${data.record.reference.number}`}
            onPress={() => {
              if (data.record?.url)
                void Linking.openURL(data.record.url).catch(() =>
                  setError("Could not open the PR link."),
                );
            }}
          />
          <ControlPill
            label="Refresh PR"
            disabled={busy}
            onPress={() => void send({ kind: "refresh", id })}
          />
          {detail && (
            <>
              <Text>
                {detail.title} · {detail.state}
                {detail.isDraft ? " · Draft" : ""}
              </Text>
              <Text>
                Review: {data.summary?.reviewDecision ?? "No decision"} · Mergeability:{" "}
                {detail.mergeability}
              </Text>
              <Text>
                Reviewers:{" "}
                {(data.activity?.reviewers ?? detail.reviewers)
                  .map((actor) => actor.login)
                  .join(", ") || "None"}
              </Text>
              <Text>Checks: {detail.checks.length === 0 ? "None reported" : ""}</Text>
              {detail.checks.map((check) => (
                <Text key={check.name}>
                  {check.name}: {check.status}
                </Text>
              ))}
              <ControlPill
                label={`${comments ? "Hide" : "Show"} comments (${data.activity?.commentCount ?? 0})`}
                onPress={() => setComments(!comments)}
              />
              {comments && (
                <>
                  {data.activity?.comments.map((comment) => (
                    <View key={comment.id} className="gap-1">
                      <Text>
                        {comment.author?.login ?? "Unknown"}
                        {comment.reviewState ? ` · ${comment.reviewState}` : ""}
                      </Text>
                      <Text selectable>{comment.body}</Text>
                    </View>
                  ))}
                  {data.activity?.commentsTruncated && (
                    <Text>Open PR to read the remaining comments.</Text>
                  )}
                </>
              )}
              {detail.state === "open" &&
                !detail.isDraft &&
                detail.viewerPermissions.actions.includes("merge") && (
                  <View className="flex-row flex-wrap gap-2">
                    {(["merge", "squash", "rebase"] as const)
                      .filter((method) => detail.mergeCapabilities[method])
                      .map((method) => (
                        <ControlPill
                          key={method}
                          label={`Merge (${method})`}
                          disabled={busy}
                          onPress={() => setMerge(method)}
                        />
                      ))}
                  </View>
                )}
              {merge && (
                <View className="gap-2">
                  <Text>
                    Merge PR #{detail.number} into {detail.baseBranch} using {merge}?
                  </Text>
                  <ControlPill
                    label="Confirm merge"
                    disabled={busy}
                    onPress={() => void send({ kind: "merge", id, mergeMethod: merge })}
                  />
                  <ControlPill label="Cancel" disabled={busy} onPress={() => setMerge(null)} />
                </View>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {data.record?.status === "creating" && (
            <Text>Committing, pushing and creating the pull request…</Text>
          )}
          {data.unavailableReason ? (
            <Text className="text-muted-foreground">{data.unavailableReason}</Text>
          ) : draft ? (
            <>
              <Text>PR title</Text>
              <TextInput
                accessibilityLabel="PR title"
                className="rounded-lg border border-border p-3 text-foreground"
                value={draft.title}
                maxLength={256}
                editable={!busy}
                onChangeText={(title) => setDraft({ ...draft, title })}
              />
              <Text>PR body</Text>
              <TextInput
                accessibilityLabel="PR body"
                className="min-h-64 rounded-lg border border-border p-3 text-foreground"
                multiline
                textAlignVertical="top"
                value={draft.body}
                maxLength={65_536}
                editable={!busy}
                onChangeText={(body) => setDraft({ ...draft, body })}
              />
              <Text className="text-sm text-muted-foreground">
                Submission commits all current changes in the execution worktree, pushes its branch
                and creates the PR. Review the diff in View Changes first. Issue links do not close
                issues; add closing syntax only when intended.
              </Text>
              <ControlPill
                label="Commit, Push & Create PR"
                disabled={busy || !draft.title.trim()}
                onPress={create}
              />
              <ControlPill label="Cancel" disabled={busy} onPress={() => setDraft(null)} />
            </>
          ) : (
            <ControlPill
              label="Create Pull Request"
              disabled={busy}
              onPress={() => {
                setDraftRevision(data.item.revision);
                setDraft(data.draft);
              }}
            />
          )}
        </>
      )}
    </View>
  );
}
