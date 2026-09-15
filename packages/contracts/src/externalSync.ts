import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";
// Optional fields keep snapshots written by older servers readable.
export const ExternalSyncMetadata = Schema.Struct({
  lastSyncedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  lastAttemptAt: Schema.optionalKey(IsoDateTime),
  syncStatus: Schema.optionalKey(Schema.Literals(["ready", "partial", "error", "unavailable"])),
  syncError: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
});
