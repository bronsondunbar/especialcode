import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferences } from "@t3tools/contracts";
const encode = Schema.encodeEffect(Schema.fromJsonString(NotificationPreferences));
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE notification_preferences (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`INSERT INTO notification_preferences VALUES (1,0,${yield* encode(DEFAULT_NOTIFICATION_PREFERENCES)})`;
  yield* sql`ALTER TABLE application_notifications ADD COLUMN in_app INTEGER NOT NULL DEFAULT 1`;
  // Previously received inbox history must never be delivered as native alerts on upgrade.
  yield* sql`ALTER TABLE application_notifications ADD COLUMN desktop INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE INDEX application_notifications_delivery ON application_notifications(desktop,sequence)`;
});
