import { WorkDetails } from "./WorkDetails";
import { createWorkItemAtoms } from "@t3tools/client-runtime/state/work-items";
import { workTaskDiscussionSources, type EnvironmentId, type WorkItem } from "@t3tools/contracts";
import { Linking, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const atoms = createWorkItemAtoms(connectionAtomRuntime);

export function WorkTaskContext({ item }: { environmentId: EnvironmentId; item: WorkItem }) {
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text className="font-semibold">Description</Text>
      <Text selectable>{item.body.trim() || "No description provided."}</Text>
    </View>
  );
}

export function WorkTaskDiscussions({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: WorkItem;
}) {
  const sources = workTaskDiscussionSources(item).filter((source) => source.kind === "github");
  if (!sources.length) return null;
  return (
    <WorkDetails title="GitHub comments">
      {sources.map((source) => (
        <IssueComments
          key={source.key}
          environmentId={environmentId}
          taskId={item.id}
          source={source}
        />
      ))}
    </WorkDetails>
  );
}

function IssueComments({
  environmentId,
  taskId,
  source,
}: {
  environmentId: EnvironmentId;
  taskId: WorkItem["id"];
  source: ReturnType<typeof workTaskDiscussionSources>[number];
}) {
  const query = useEnvironmentQuery(
    atoms.discussionDetails({
      environmentId,
      input: { taskId, sourceKey: source.key },
    }),
  );
  const issue = query.data?.githubIssue;
  return (
    <View className="gap-3 border-t border-border pt-3">
      <Text className="font-semibold">{source.label}</Text>
      <View className="flex-row flex-wrap gap-2">
        <ControlPill label="Refresh comments" disabled={query.isPending} onPress={query.refresh} />
        <ControlPill label="Open issue" onPress={() => void Linking.openURL(source.url)} />
      </View>
      {query.isPending && <Text>Loading comments…</Text>}
      {query.error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {query.error}
        </Text>
      )}
      {issue?.comments.length === 0 && <Text>No comments on this issue.</Text>}
      {issue?.comments.map((comment) => (
        <View key={comment.id} className="gap-2 rounded-lg border border-border p-3">
          <Text className="text-xs text-muted-foreground">
            @{comment.author} · {new Date(comment.createdAt).toLocaleString()}
          </Text>
          <Text selectable>{comment.body}</Text>
        </View>
      ))}
    </View>
  );
}
