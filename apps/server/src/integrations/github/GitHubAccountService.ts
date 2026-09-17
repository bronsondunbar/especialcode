import { GitHubAccount, GitHubAccountInput, GitHubIssuesError } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { GitHubIssuesAdapter, accountSecretName } from "./GitHubIssuesAdapter.ts";
import { GitHubIssuesService } from "./GitHubIssuesService.ts";

const decodeAccount = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubAccount));
const encodeAccount = Schema.encodeSync(Schema.fromJsonString(GitHubAccount));
const isGitHubIssuesError = Schema.is(GitHubIssuesError);
const decodeInput = Schema.decodeUnknownEffect(GitHubAccountInput);
const safeError = (error: unknown) =>
  isGitHubIssuesError(error)
    ? error
    : new GitHubIssuesError({
        code: "storage",
        message: "Could not save the GitHub connection. Retry later.",
      });
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const adapter = yield* GitHubIssuesAdapter;
  const issues = yield* GitHubIssuesService;
  const lock = yield* Semaphore.make(1);
  const account = Effect.gen(function* () {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM github_account WHERE id=1`;
    return rows[0] ? yield* decodeAccount(rows[0].record_json) : null;
  });
  const fetchAssigned = Effect.fn("GitHubAccountService.fetchAssigned")(function* (
    token: string,
    previous: GitHubAccount | null,
  ) {
    const viewer = yield* adapter.viewer(token);
    if (previous && previous.id !== viewer.id)
      return yield* new GitHubIssuesError({
        code: "authentication",
        message:
          "This token belongs to another account. Disconnect before connecting a different account.",
      });
    const snapshots = yield* adapter.assigned(token);
    const at = DateTime.formatIso(yield* DateTime.now);
    return {
      snapshots: snapshots.issues,
      next: {
        ...viewer,
        lastSyncedAt: at,
        lastAttemptAt: at,
        syncStatus: snapshots.partialAccess ? ("partial" as const) : ("ready" as const),
        syncError: snapshots.partialAccess
          ? "Some organizations were excluded by GitHub. Authorize this token for their SSO, then sync again."
          : null,
      },
    };
  });
  const sync = Effect.fn("GitHubAccountService.sync")(function* () {
    const previous = yield* account;
    if (!previous) return;
    yield* Effect.gen(function* () {
      const token = yield* secrets.get(accountSecretName);
      if (Option.isNone(token))
        return yield* new GitHubIssuesError({
          code: "authentication",
          message: "Reconnect your GitHub account.",
        });
      const fetched = yield* fetchAssigned(new TextDecoder().decode(token.value), previous);
      yield* issues.ingestAssigned(fetched.next, fetched.snapshots);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const failure = safeError(error);
          const next: GitHubAccount = {
            ...previous,
            lastAttemptAt: DateTime.formatIso(yield* DateTime.now),
            syncStatus: "error",
            syncError: failure.message,
          };
          yield* sql`UPDATE github_account SET record_json=${encodeAccount(next)} WHERE id=1`;
          return yield* failure;
        }),
      ),
    );
  });
  const admin = Effect.fn("GitHubAccountService.admin")(
    function* (raw: GitHubAccountInput) {
      const input = yield* decodeInput(raw).pipe(
        Effect.mapError(
          () => new GitHubIssuesError({ code: "invalid", message: "Enter a valid GitHub token." }),
        ),
      );
      if (input.kind === "sync") return yield* sync();
      if (input.kind === "disconnect") {
        yield* Effect.gen(function* () {
          yield* secrets.remove(accountSecretName);
          yield* sql`DELETE FROM github_account WHERE id=1`;
        }).pipe(Effect.uninterruptible);
        return;
      }
      const previous = yield* account;
      const fetched = yield* fetchAssigned(input.token.trim(), previous);
      const oldSecret = yield* secrets.get(accountSecretName);
      yield* Effect.gen(function* () {
        yield* secrets.set(accountSecretName, new TextEncoder().encode(input.token.trim()));
        yield* issues.ingestAssigned(fetched.next, fetched.snapshots).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Option.isSome(oldSecret)
                ? secrets.set(accountSecretName, oldSecret.value)
                : secrets.remove(accountSecretName);
              return yield* error;
            }),
          ),
        );
      }).pipe(Effect.uninterruptible);
    },
    lock.withPermits(1),
    Effect.mapError(safeError),
    Effect.ensuring(issues.notifyChange),
  );
  const worker = yield* makeDrainableWorker(() =>
    admin({ kind: "sync" }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Assigned GitHub issue sync failed").pipe(
          Effect.annotateLogs({ code: error.code }),
        ),
      ),
    ),
  );
  const start = Effect.fn("GitHubAccountService.start")(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.asVoid),
    );
  });
  const repositories = Effect.fn("GitHubAccountService.repositories")(function* () {
    const connected = yield* account;
    if (!connected) return { login: null, repositories: [], partialAccess: false };
    const token = yield* secrets.get(accountSecretName);
    if (Option.isNone(token))
      return yield* new GitHubIssuesError({
        code: "authentication",
        message: "Reconnect your GitHub account to load repositories.",
      });
    return {
      login: connected.login,
      ...(yield* adapter.repositories(new TextDecoder().decode(token.value))),
    };
  }, Effect.mapError(safeError));
  return { admin, start, repositories, drain: worker.drain };
});
export class GitHubAccountService extends Context.Service<
  GitHubAccountService,
  Effect.Success<typeof make>
>()("t3/integrations/github/GitHubAccountService") {}
