import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_automation_control (id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL,revision INTEGER NOT NULL)`;
  yield* sql`INSERT INTO work_automation_control VALUES (1,0,0)`;
  yield* sql`CREATE INDEX work_execution_automation_owner ON work_item_executions(json_extract(record_json,'$.automation.ruleId'),status)`;
});
