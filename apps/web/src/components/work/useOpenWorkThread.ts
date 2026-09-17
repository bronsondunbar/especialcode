import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "../../state/entities";

/** Wait for the created thread to reach the client before leaving the issue. */
export function useOpenWorkThread(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  onClose: () => void,
) {
  const navigate = useNavigate();
  const thread = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || !thread) return;
    const key = `${environmentId}:${threadId}`;
    if (opened.current === key) return;
    opened.current = key;
    onClose();
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  }, [environmentId, threadId, thread, navigate, onClose]);
}
