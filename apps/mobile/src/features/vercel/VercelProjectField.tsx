import { useState } from "react";
import { View } from "react-native";
import { createVercelAtoms } from "@t3tools/client-runtime/state/vercel";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
const atoms = createVercelAtoms(connectionAtomRuntime);
export type VercelSelection = { project: string | null } | undefined;
type Props = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  value: VercelSelection;
  onChange: (value: VercelSelection) => void;
  disabled?: boolean;
};
export function VercelProjectField(props: Props) {
  const { environments } = useEnvironments();
  if (
    !environments.find((env) => env.environmentId === props.environmentId)?.serverConfig
      ?.environment.capabilities.vercel
  )
    return null;
  return <ProjectField {...props} />;
}
function ProjectField({ environmentId, value, onChange, disabled }: Props) {
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const query = useEnvironmentQuery(
    atoms.projects({ environmentId, input: { search: queryText } }),
  );
  const projects = query.data?.projects ?? [];
  const current = value?.project ?? "none";
  const choices = [
    {
      id: "none",
      title: query.data?.connection ? "Do not link to Vercel" : "No Vercel connection",
    },
    ...(value?.project && !projects.some((project) => project.id === value.project)
      ? [{ id: value.project, title: value.project }]
      : []),
    ...projects.map((project) => ({ id: project.id, title: project.name })),
  ];
  return (
    <View className="gap-2 rounded-lg border border-border p-3">
      <Text className="font-medium">Vercel project</Text>
      <ControlPillMenu
        title="Vercel project"
        actions={choices.map((choice) => ({
          ...choice,
          disabled: disabled || !query.data?.connection,
        }))}
        onPressAction={({ nativeEvent }) => {
          if (!disabled)
            onChange(nativeEvent.event === "none" ? undefined : { project: nativeEvent.event });
        }}
      >
        <ControlPill
          disabled={disabled || !query.data?.connection}
          label={choices.find((choice) => choice.id === current)?.title ?? current}
        />
      </ControlPillMenu>
      {query.data?.connection && (
        <>
          <TextInput
            accessibilityLabel="Search Vercel projects"
            className="rounded-lg border border-border p-3 text-foreground"
            placeholder="Search Vercel projects by name"
            value={search}
            editable={!disabled}
            maxLength={200}
            onChangeText={setSearch}
          />
          <ControlPill
            label="Search"
            disabled={disabled}
            onPress={() => setQueryText(search.trim())}
          />
          <Text className="text-xs text-muted-foreground">
            Follows the thread’s branch. Showing up to 20 projects; search for another.
          </Text>
        </>
      )}
      {query.isPending && <Text>Loading Vercel projects…</Text>}
      {query.error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {query.error}
        </Text>
      )}
      {query.data && !query.data.connection && <Text>Connect Vercel in Work → Vercel.</Text>}
    </View>
  );
}
