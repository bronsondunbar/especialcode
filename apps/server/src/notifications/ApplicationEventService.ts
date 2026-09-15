import { ApplicationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SubscriptionRef from "effect/SubscriptionRef";
const encode = Schema.encodeEffect(Schema.fromJsonString(ApplicationEvent));
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* SubscriptionRef.make(0);
  return {
    /** Call within the producer's transaction when advancing a durable source cursor. */
    append: Effect.fn("ApplicationEventService.append")(function* (event: ApplicationEvent) {
      const json = yield* encode(event);
      yield* sql`INSERT INTO application_events(id,record_json) VALUES (${event.id},${json}) ON CONFLICT(id) DO NOTHING`;
    }),
    // Signal only after the producer commits, never before its data becomes visible.
    notifyChange: SubscriptionRef.update(changes, (n) => n + 1),
    changes: SubscriptionRef.changes(changes),
  };
});
export class ApplicationEventService extends Context.Service<
  ApplicationEventService,
  Effect.Success<typeof make>
>()("t3/notifications/ApplicationEventService") {}
