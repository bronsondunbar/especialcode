export interface WorkspaceActivity {
  readonly scope: string;
  readonly updatedAt: number;
}

export type WorkspaceSeen = Readonly<Record<string, number>>;
export const WORKSPACE_SEEN_KEY = "t3.workspace-seen.v1";

export function hasUnseenWorkspaceActivity(
  seen: WorkspaceSeen,
  activity: ReadonlyArray<WorkspaceActivity>,
) {
  return activity.some(
    (item) => Number.isFinite(item.updatedAt) && item.updatedAt > (seen[item.scope] ?? 0),
  );
}

/** Use source timestamps, not the device clock, and never move a read cursor backwards. */
export function acknowledgeWorkspaceActivity(
  seen: WorkspaceSeen,
  activity: ReadonlyArray<WorkspaceActivity>,
): WorkspaceSeen {
  let next: Record<string, number> | null = null;
  for (const item of activity) {
    if (!Number.isFinite(item.updatedAt) || item.updatedAt <= ((next ?? seen)[item.scope] ?? 0))
      continue;
    next ??= { ...seen };
    next[item.scope] = item.updatedAt;
  }
  return next ?? seen;
}

export function readWorkspaceSeen(storage?: Pick<Storage, "getItem">): WorkspaceSeen {
  try {
    const value: unknown = JSON.parse(storage?.getItem(WORKSPACE_SEEN_KEY) ?? "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, stamp]) => typeof stamp === "number" && Number.isFinite(stamp) && stamp >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function writeWorkspaceSeen(seen: WorkspaceSeen, storage?: Pick<Storage, "setItem">) {
  try {
    storage?.setItem(WORKSPACE_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // A denied or full storage must not prevent acknowledging updates in this session.
  }
}
