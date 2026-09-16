import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { workItems } from "~/state/workItems";
import {
  acknowledgeWorkspaceActivity,
  hasUnseenWorkspaceActivity,
  readWorkspaceSeen,
  writeWorkspaceSeen,
  type WorkspaceActivity,
  type WorkspaceSeen,
} from "./workspaceActivity.logic";

function storage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const useSeen = create<{
  seen: WorkspaceSeen;
  acknowledge: (activity: ReadonlyArray<WorkspaceActivity>) => void;
}>((set) => ({
  seen: readWorkspaceSeen(storage()),
  acknowledge: (activity) =>
    set((state) => {
      const seen = acknowledgeWorkspaceActivity(state.seen, activity);
      if (seen === state.seen) return state;
      writeWorkspaceSeen(seen, storage());
      return { seen };
    }),
}));

const prTarget = (environmentId: EnvironmentId) => ({
  environmentId,
  input: { state: "all" as const, involvement: "all" as const, limit: 1 },
});

/** A single newest row per environment is enough to detect changes without loading whole feeds. */
export function WorkspaceUpdatesIndicator({
  section,
  environmentIds,
  active,
}: {
  section: "work" | "prs";
  environmentIds: ReadonlyArray<EnvironmentId>;
  active: boolean;
}) {
  const key = JSON.stringify(environmentIds.toSorted());
  const activityAtom = useMemo(
    () =>
      Atom.make((get) => {
        const ids = JSON.parse(key) as EnvironmentId[];
        const activity: WorkspaceActivity[] = [];
        const readable: WorkspaceActivity[] = [];
        for (const environmentId of ids) {
          if (section === "work") {
            const result = get(
              workItems.list({ environmentId, input: { limit: 1, archived: false } }),
            );
            const data = Option.getOrNull(AsyncResult.value(result));
            const row = data?.items[0];
            if (!row) continue;
            const item = {
              scope: JSON.stringify([environmentId, section]),
              updatedAt: Date.parse(row.updatedAt),
            };
            activity.push(item);
            if (result._tag === "Success" && !result.waiting) readable.push(item);
          } else {
            const result = get(pullRequestEnvironment.list(prTarget(environmentId)));
            const data = Option.getOrNull(AsyncResult.value(result));
            for (const row of data?.entries ?? []) {
              const host = row.host.toLowerCase();
              const viewer = data?.viewers[host]?.toLowerCase();
              if (!viewer) continue;
              const item = {
                scope: JSON.stringify([environmentId, section, host, viewer]),
                updatedAt: Date.parse(row.updatedAt),
              };
              activity.push(item);
              if (result._tag === "Success" && !result.waiting) readable.push(item);
            }
          }
        }
        return { activity, readable };
      }),
    [key, section],
  );
  const { activity, readable } = useAtomValue(activityAtom);
  const seen = useSeen((state) => state.seen);
  const acknowledge = useSeen((state) => state.acknowledge);

  useLiveRefresh(
    () => {
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(pullRequestEnvironment.list(prTarget(environmentId)));
      }
    },
    {
      enabled: section === "prs" && environmentIds.length > 0,
      key: `workspace-updates:${section}:${key}`,
    },
  );

  useEffect(() => {
    const markViewed = () => {
      if (active && document.visibilityState === "visible") acknowledge(readable);
    };
    markViewed();
    document.addEventListener("visibilitychange", markViewed);
    return () => document.removeEventListener("visibilitychange", markViewed);
  }, [active, readable, acknowledge]);

  if (active || !hasUnseenWorkspaceActivity(seen, activity)) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center">
      <span aria-hidden className="size-2 rounded-full bg-blue-500" />
      <span className="sr-only">New updates</span>
    </span>
  );
}
