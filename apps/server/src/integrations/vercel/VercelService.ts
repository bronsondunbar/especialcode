import * as NodeCrypto from "node:crypto";
import {
  VercelAdminInput,
  VercelReadInput,
  VercelLinkInput,
  VercelConnection,
  VercelThreadLink,
  VercelError,
  VercelProjectsInput,
  type ProjectId,
  type ThreadId,
  type VercelSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VercelAdapter, fail } from "./VercelAdapter.ts";
const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(VercelConnection));
const encodeConnection = Schema.encodeSync(Schema.fromJsonString(VercelConnection));
const decodeLink = Schema.decodeUnknownEffect(Schema.fromJsonString(VercelThreadLink));
const encodeLink = Schema.encodeSync(Schema.fromJsonString(VercelThreadLink));
const decodeAdmin = Schema.decodeUnknownEffect(VercelAdminInput);
const decodeRead = Schema.decodeUnknownEffect(VercelReadInput);
const decodeMutation = Schema.decodeUnknownEffect(VercelLinkInput);
const decodeProjectsInput = Schema.decodeUnknownEffect(VercelProjectsInput);
const isError = Schema.is(VercelError);
const storageError = (error: unknown) =>
  isError(error) ? error : fail("Could not access the Vercel connection.");
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const adapter = yield* VercelAdapter;
  const lock = yield* Semaphore.make(1);
  const validate = Effect.fn("VercelService.validate")(function* (
    projectId: ProjectId,
    threadId?: ThreadId,
  ) {
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
    if (!projects.length) return yield* fail("This local project is unavailable.");
    if (!threadId) return null;
    const threads = yield* sql<{
      branch: string | null;
    }>`SELECT branch FROM projection_threads WHERE thread_id=${threadId} AND project_id=${projectId} AND deleted_at IS NULL`;
    if (!threads[0]) return yield* fail("This thread does not belong to the selected project.");
    return threads[0].branch;
  });
  const saved = Effect.fn("VercelService.saved")(function* () {
    const rows = yield* sql<{
      record_json: string;
      secret_name: string;
    }>`SELECT record_json, secret_name FROM vercel_connection WHERE id=1`;
    return rows[0]
      ? {
          connection: yield* decodeConnection(rows[0].record_json),
          secretName: rows[0].secret_name,
        }
      : null;
  });
  const credentials = Effect.fn("VercelService.credentials")(function* (
    config: NonNullable<Effect.Success<ReturnType<typeof saved>>>,
  ) {
    const token = yield* secrets.get(config.secretName);
    if (Option.isNone(token)) return yield* fail("Reconnect Vercel in Work → Vercel.");
    return { token: new TextDecoder().decode(token.value), teamId: config.connection.teamId };
  });
  const admin = Effect.fn("VercelService.admin")(
    function* (raw: VercelAdminInput) {
      const input = yield* decodeAdmin(raw);
      const previous = yield* saved();
      const legacy = yield* sql<{ secret_name: string }>`SELECT secret_name FROM vercel_projects`;
      if (input.kind === "disconnect") {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM vercel_connection`;
            yield* sql`DELETE FROM vercel_projects`;
            yield* sql`DELETE FROM vercel_threads`;
          }),
        );
        if (previous) yield* secrets.remove(previous.secretName);
        for (const row of legacy) yield* secrets.remove(row.secret_name).pipe(Effect.ignore);
        return;
      }
      yield* adapter.projects({ token: input.token, teamId: input.teamId }, "");
      const secretName = `vercel-${NodeCrypto.randomUUID()}`;
      yield* secrets.set(secretName, new TextEncoder().encode(input.token));
      const connection = { teamId: input.teamId };
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO vercel_connection(id, secret_name, record_json) VALUES (1, ${secretName}, ${encodeConnection(connection)}) ON CONFLICT(id) DO UPDATE SET secret_name=excluded.secret_name, record_json=excluded.record_json`;
            yield* sql`DELETE FROM vercel_projects`;
            // A different team cannot reuse links scoped to the previous team.
            if (previous && previous.connection.teamId !== input.teamId)
              yield* sql`DELETE FROM vercel_threads`;
          }),
        )
        .pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
      if (previous) yield* secrets.remove(previous.secretName).pipe(Effect.ignore);
      for (const row of legacy) yield* secrets.remove(row.secret_name).pipe(Effect.ignore);
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  const link = Effect.fn("VercelService.link")(
    function* (raw: VercelLinkInput) {
      const input = yield* decodeMutation(raw);
      yield* validate(input.projectId, input.threadId);
      if (input.kind === "unlink") {
        yield* sql`DELETE FROM vercel_threads WHERE thread_id=${input.threadId}`;
        return;
      }
      const config = yield* saved();
      if (!config) return yield* fail("Connect Vercel in Work → Vercel first.");
      const record: VercelThreadLink = {
        project: yield* adapter.project(yield* credentials(config), input.vercelProject),
        branch: input.branch,
      };
      yield* sql`INSERT INTO vercel_threads(thread_id, project_id, record_json) VALUES (${input.threadId}, ${input.projectId}, ${encodeLink(record)}) ON CONFLICT(thread_id) DO UPDATE SET project_id=excluded.project_id, record_json=excluded.record_json`;
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  const read = Effect.fn("VercelService.read")(function* (raw: VercelReadInput) {
    const input = yield* decodeRead(raw);
    if (input.threadId && !input.projectId)
      return yield* fail("Select the thread’s local project.");
    const branch = input.projectId ? yield* validate(input.projectId, input.threadId) : null;
    const config = yield* saved();
    const records = input.threadId
      ? yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM vercel_threads WHERE thread_id=${input.threadId} AND project_id=${input.projectId}`
      : [];
    const override = records[0] ? yield* decodeLink(records[0].record_json) : null;
    const link = config && override ? { ...override, branch: override.branch ?? branch } : null;
    const snapshot: VercelSnapshot = {
      connection: config?.connection ?? null,
      link,
      deployments: [],
      selectedDeploymentId: null,
      logs: "",
      logsTruncated: false,
      error: null,
      logsError: null,
      checkedAt: null,
    };
    if (!config || !link || input.configurationOnly) return snapshot;
    // A detached thread must choose a branch before showing deployments from the whole project.
    if (input.threadId && !link.branch)
      return { ...snapshot, error: "Choose a branch to follow deployments for this thread." };
    const fetched = yield* Effect.gen(function* () {
      const access = yield* credentials(config);
      const deployments = yield* adapter.deployments(access, link.project.id, link.branch);
      const selected = input.deploymentId
        ? deployments.find((deployment) => deployment.id === input.deploymentId)
        : deployments[0];
      const result = {
        ...snapshot,
        deployments,
        selectedDeploymentId: selected?.id ?? null,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (!input.includeLogs) return result;
      if (input.deploymentId && !selected)
        return {
          ...result,
          logsError: "Select a deployment from this project's current branch results.",
        };
      if (!selected) return result;
      const logs = yield* adapter.logs(access, selected.id).pipe(Effect.result);
      return logs._tag === "Success"
        ? { ...result, logs: logs.success.text, logsTruncated: logs.success.truncated }
        : { ...result, logsError: logs.failure.message };
    }).pipe(Effect.result);
    return fetched._tag === "Success"
      ? fetched.success
      : { ...snapshot, error: storageError(fetched.failure).message };
  }, Effect.mapError(storageError));
  const projects = Effect.fn("VercelService.projects")(function* (
    raw: typeof VercelProjectsInput.Type,
  ) {
    const input = yield* decodeProjectsInput(raw);
    const config = yield* saved();
    if (!config) return { connection: null, projects: [] };
    return {
      connection: config.connection,
      projects: yield* adapter.projects(yield* credentials(config), input.search?.trim() ?? ""),
    };
  }, Effect.mapError(storageError));
  return { admin, link, read, projects };
});
export class VercelService extends Context.Service<VercelService, Effect.Success<typeof make>>()(
  "t3/integrations/vercel/VercelService",
) {}
