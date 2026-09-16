import { describe, expect, it } from "vite-plus/test";
import {
  acknowledgeWorkspaceActivity,
  hasUnseenWorkspaceActivity,
  readWorkspaceSeen,
  writeWorkspaceSeen,
  WORKSPACE_SEEN_KEY,
} from "./workspaceActivity.logic";

describe("workspace update indicators", () => {
  const work = { scope: '["server-a","work"]', updatedAt: 100 };
  const prs = { scope: '["server-a","prs","github.com","alice"]', updatedAt: 200 };

  it("shows unseen content, clears it on viewing, and shows later updates", () => {
    expect(hasUnseenWorkspaceActivity({}, [work])).toBe(true);
    const seen = acknowledgeWorkspaceActivity({}, [work]);
    expect(hasUnseenWorkspaceActivity(seen, [work])).toBe(false);
    expect(hasUnseenWorkspaceActivity(seen, [{ ...work, updatedAt: 101 }])).toBe(true);
    expect(acknowledgeWorkspaceActivity(seen, [work])).toBe(seen);
  });

  it("keeps Work, PRs, servers, and connected accounts independent", () => {
    const seen = acknowledgeWorkspaceActivity({}, [work, prs]);
    expect(hasUnseenWorkspaceActivity(seen, [work, prs])).toBe(false);
    expect(hasUnseenWorkspaceActivity(acknowledgeWorkspaceActivity({}, [work]), [prs])).toBe(true);
    expect(hasUnseenWorkspaceActivity(seen, [{ ...work, scope: '["server-b","work"]' }])).toBe(
      true,
    );
    expect(
      hasUnseenWorkspaceActivity(seen, [
        { ...prs, scope: '["server-a","prs","github.com","bob"]' },
      ]),
    ).toBe(true);
  });

  it("does not turn older snapshots, deleted items, or invalid timestamps into new activity", () => {
    const seen = acknowledgeWorkspaceActivity({}, [work]);
    expect(acknowledgeWorkspaceActivity(seen, [{ ...work, updatedAt: 50 }])).toBe(seen);
    expect(hasUnseenWorkspaceActivity(seen, [{ ...work, updatedAt: 50 }])).toBe(false);
    expect(hasUnseenWorkspaceActivity(seen, [])).toBe(false);
    expect(hasUnseenWorkspaceActivity({}, [{ ...work, updatedAt: NaN }])).toBe(false);
    expect(acknowledgeWorkspaceActivity(seen, [{ ...work, updatedAt: Infinity }])).toBe(seen);
  });

  it("remembers viewed updates across reloads", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    writeWorkspaceSeen(acknowledgeWorkspaceActivity({}, [work, prs]), storage);
    expect(hasUnseenWorkspaceActivity(readWorkspaceSeen(storage), [work, prs])).toBe(false);
    expect(
      hasUnseenWorkspaceActivity(readWorkspaceSeen(storage), [{ ...work, updatedAt: 101 }]),
    ).toBe(true);
    entries.set(WORKSPACE_SEEN_KEY, '{"valid":100,"invalid":"bad","negative":-1}');
    expect(readWorkspaceSeen(storage)).toEqual({ valid: 100 });
    entries.set(WORKSPACE_SEEN_KEY, "not json");
    expect(readWorkspaceSeen(storage)).toEqual({});
  });

  it("continues when storage is unavailable", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readWorkspaceSeen(denied)).toEqual({});
    expect(() => writeWorkspaceSeen({ work: 100 }, denied)).not.toThrow();
  });
});
