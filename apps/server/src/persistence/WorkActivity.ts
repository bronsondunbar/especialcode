import * as NodeCrypto from "node:crypto";
import { WorkActivityEvent, WorkActivityError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
const encode = Schema.encodeEffect(Schema.fromJsonString(WorkActivityEvent));
export const activityId = (source: string) =>
  NodeCrypto.createHash("sha256").update(source).digest("hex");
/** Append inside the producer transaction; signal WorkItem changes only after commit. */
export const makeWorkActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    append: Effect.fn("WorkActivityRepository.append")(function* (event: WorkActivityEvent) {
      const parsed = DateTime.make(event.occurredAt);
      if (Option.isNone(parsed))
        return yield* new WorkActivityError({ message: "Activity needs a valid timestamp." });
      const occurredAt = DateTime.formatIso(parsed.value);
      const record = yield* encode({ ...event, occurredAt });
      yield* sql`INSERT INTO work_item_activity(id,work_item_id,occurred_at,record_json) VALUES (${event.id},${event.workItemId},${occurredAt},${record}) ON CONFLICT(id) DO NOTHING`;
    }),
  };
});
