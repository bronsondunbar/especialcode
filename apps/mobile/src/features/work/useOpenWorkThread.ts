import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { environmentThreadShells } from "../../state/threads";

const emptyThread = Atom.make<EnvironmentThreadShell | null>(null);

/** Wait for the created thread to reach the client before leaving the issue. */
export function useOpenWorkThread(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  onClose: () => void,
) {
  const navigation = useNavigation();
  const thread = useAtomValue(
    threadId
      ? environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId))
      : emptyThread,
  );
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || !thread) return;
    const key = `${environmentId}:${threadId}`;
    if (opened.current === key) return;
    opened.current = key;
    onClose();
    navigation.navigate("Thread", { environmentId, threadId });
  }, [environmentId, threadId, thread, navigation, onClose]);
}
