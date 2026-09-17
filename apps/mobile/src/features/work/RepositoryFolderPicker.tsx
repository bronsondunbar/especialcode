import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import { createFilesystemEnvironmentAtoms } from "@t3tools/client-runtime/state/filesystem";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export function RepositoryFolderPicker({
  environmentId,
  value,
  disabled,
  onSelect,
}: {
  environmentId: EnvironmentId;
  value: string;
  disabled?: boolean;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hideHidden, setHideHidden] = useState(true);
  const [path, setPath] = useState("~/");
  const [location, setLocation] = useState("~/");
  const folders = useEnvironmentQuery(
    open
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: ensureBrowseDirectoryPath(path) },
        })
      : null,
  );
  const navigate = (next: string) => {
    setPath(next);
    setLocation(next);
  };
  const current = folders.data;
  const entries = (current?.entries ?? []).filter(
    (entry) => !hideHidden || !entry.name.startsWith("."),
  );
  const parent = current
    ? getBrowseParentPath(ensureBrowseDirectoryPath(current.parentPath))
    : null;
  return (
    <>
      <View className="gap-2 rounded-lg border border-border p-3">
        <Text className="text-sm text-muted-foreground">{value || "No folder selected"}</Text>
        <ControlPill
          label={value ? "Change folder" : "Choose folder"}
          disabled={disabled}
          onPress={() => {
            navigate(value || "~/");
            setOpen(true);
          }}
        />
      </View>
      <Modal visible={open} presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView className="flex-1 bg-background">
          <View className="gap-3 p-4">
            <Text className="text-xl font-semibold">Select repository folder</Text>
            <Text className="text-sm text-muted-foreground">
              Choose the cloned repository on the connected server.
            </Text>
            <TextInput
              accessibilityLabel="Folder location"
              className="rounded-lg border border-border p-3 text-foreground"
              value={location}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setLocation}
              onSubmitEditing={() => {
                if (location.trim()) navigate(location.trim());
              }}
            />
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                label="Go"
                disabled={!location.trim()}
                onPress={() => navigate(location.trim())}
              />
              <ControlPill
                label="Up"
                disabled={!parent || folders.isPending}
                onPress={() => {
                  if (parent) navigate(parent);
                }}
              />
              <ControlPill label="Home" onPress={() => navigate("~/")} />
            </View>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: hideHidden }}
              accessibilityLabel="Hide hidden files and folders"
              className="min-h-11 flex-row items-center gap-2"
              onPress={() => setHideHidden((hidden) => !hidden)}
            >
              <View
                className={`size-5 items-center justify-center rounded border ${hideHidden ? "border-primary bg-primary" : "border-border"}`}
              >
                {hideHidden && <Text className="text-xs text-primary-foreground">✓</Text>}
              </View>
              <Text className="flex-1 text-sm">Hide hidden files and folders</Text>
            </Pressable>
            {folders.isPending && <Text>Loading folders…</Text>}
            {folders.error && (
              <Text accessibilityRole="alert" className="text-destructive">
                {folders.error}
              </Text>
            )}
            {current && !folders.error && (
              <Text className="text-xs text-muted-foreground">{current.parentPath}</Text>
            )}
          </View>
          <ScrollView
            className="flex-1"
            contentContainerClassName="gap-2 px-4"
            keyboardShouldPersistTaps="handled"
          >
            {current && !folders.error && (
              <>
                {entries.map((entry) => (
                  <ControlPill
                    key={entry.fullPath}
                    label={entry.name}
                    accessibilityLabel={`Open folder ${entry.name}`}
                    disabled={folders.isPending}
                    onPress={() => navigate(entry.fullPath)}
                  />
                ))}
                {!entries.length && (
                  <Text className="text-muted-foreground">No visible subfolders.</Text>
                )}
              </>
            )}
          </ScrollView>
          <View className="flex-row gap-2 border-t border-border p-4">
            <ControlPill label="Cancel" onPress={() => setOpen(false)} />
            <ControlPill
              label="Select folder"
              disabled={disabled || folders.isPending || !!folders.error || !current}
              onPress={() => {
                if (current) {
                  onSelect(current.parentPath);
                  setOpen(false);
                }
              }}
            />
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}
