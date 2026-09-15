import { createNotificationAtoms } from "@t3tools/client-runtime/state/work-items";
import { connectionAtomRuntime } from "../connection/runtime";
export const notifications = createNotificationAtoms(connectionAtomRuntime);
