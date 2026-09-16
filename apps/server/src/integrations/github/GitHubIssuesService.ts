import * as NodeCrypto from "node:crypto";
import { makeEventRepository } from "../../automations/AutomationEvents.ts";
import { makeWorkActivityRepository, activityId } from "../../persistence/WorkActivity.ts";
import {
  GitHubAccount,
  GitHubIssue,
  GitHubIssueSummary,
  GitHubIssueReference,
  GitHubIssuesError,
  GitHubIssuesListInput,
  GitHubIssuesMutation,
  GitHubTrackedRepository,
  WorkItemId,
  type GitHubRepositoryKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkItemService } from "../../workItems/WorkItemService.ts";
import { GitHubIssuesAdapter } from "./GitHubIssuesAdapter.ts";

const encodeAccount = Schema.encodeEffect(Schema.fromJsonString(GitHubAccount));
const decodeAccount = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubAccount));
const encodeRepo = Schema.encodeSync(Schema.fromJsonString(GitHubTrackedRepository));
const decodeRepo = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubTrackedRepository));
const encodeIssue = Schema.encodeEffect(Schema.fromJsonString(GitHubIssue));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssueSummary));
const decodeMutation = Schema.decodeUnknownEffect(GitHubIssuesMutation);
const decodeList = Schema.decodeUnknownEffect(GitHubIssuesListInput);
const decodeReference = Schema.decodeUnknownEffect(GitHubIssueReference);
const isError = Schema.is(GitHubIssuesError);
const fail = (code: GitHubIssuesError["code"], message: string) =>
  new GitHubIssuesError({ code, message });
const storageError = (error: unknown) =>
  isError(error) ? error : fail("storage", "Could not access GitHub issue data. Please retry.");
const repositoryNamespace = (repo: GitHubRepositoryKey) =>
  `${repo.host.toLowerCase()}/${repo.repository.toLowerCase()}`;
const resource = (issue: GitHubIssue) => ({
  source: "github_issue" as const,
  namespace: repositoryNamespace(issue),
  externalId: issue.externalId,
  url: issue.url,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const adapter = yield* GitHubIssuesAdapter;
  const workItems = yield* WorkItemService;
  const activity = yield* makeWorkActivityRepository;
  const automationEvents = yield* makeEventRepository;
  const changes = yield* SubscriptionRef.make(0);
  // One server-scoped coordinator serializes configuration and sync across clients.
  const lock = yield* Semaphore.make(1);
  const repositories = Effect.fn("GitHubIssuesService.repositories")(function* () {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM github_tracked_repositories ORDER BY namespace`;
    return yield* Effect.forEach(rows, (row) => decodeRepo(row.record_json));
  });
  const tracked = Effect.fn("GitHubIssuesService.tracked")(function* (key: GitHubRepositoryKey) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM github_tracked_repositories WHERE namespace=${repositoryNamespace(key)}`;
    if (!rows[0])
      return yield* fail("not_found", "Track this repository before syncing or importing issues.");
    return yield* decodeRepo(rows[0].record_json);
  });
  const saveRepo = (
    repo: GitHubTrackedRepository,
  ) => sql`INSERT INTO github_tracked_repositories(namespace, record_json)
    VALUES (${repositoryNamespace(repo)}, ${encodeRepo(repo)}) ON CONFLICT(namespace) DO UPDATE SET record_json=excluded.record_json`;
  const saveIssue = Effect.fn("GitHubIssuesService.saveIssue")(function* (issue: GitHubIssue) {
    const old = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM github_issues WHERE namespace=${repositoryNamespace(issue)} AND external_id=${issue.externalId}`;
    const previous = old[0] ? yield* decodeIssue(old[0].record_json) : null;
    if (previous && issue.updatedAt < previous.updatedAt) return;
    const record = yield* encodeIssue(issue);
    yield* sql`INSERT INTO github_issues(namespace, external_id, number, state, updated_at, record_json)
      VALUES (${repositoryNamespace(issue)}, ${issue.externalId}, ${issue.number}, ${issue.state}, ${issue.updatedAt}, ${record})
      ON CONFLICT(namespace, external_id) DO UPDATE SET number=excluded.number, state=excluded.state, updated_at=excluded.updated_at, record_json=excluded.record_json`;
    const nextLabels = [...issue.labels].sort();
    const labelsChanged =
      previous &&
      (previous.labels.length !== nextLabels.length ||
        [...previous.labels].sort().some((label, index) => label !== nextLabels[index]));
    if (!previous || labelsChanged) {
      const repo = yield* tracked(issue);
      const item = yield* workItems.findByResource(resource(issue));
      yield* automationEvents.append({
        id: `github:${NodeCrypto.randomUUID()}`,
        trigger: previous ? "github_label_changed" : "github_issue_synced",
        occurredAt: DateTime.formatIso(yield* DateTime.now),
        workItemId: item?.id ?? null,
        projectId: item?.projectId ?? repo.projectId,
        title: issue.title,
        repository: issue.repository,
        labels: issue.labels,
        status: item?.status ?? null,
        hasAgentThread: item?.agentThreadId != null,
        issue: { host: issue.host, repository: issue.repository, number: issue.number },
      });
    }
  }, sql.withTransaction);
  const cached = Effect.fn("GitHubIssuesService.cached")(function* (ref: GitHubIssueReference) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM github_issues WHERE namespace=${repositoryNamespace(ref)} AND number=${ref.number}`;
    return rows[0] ? yield* decodeIssue(rows[0].record_json) : null;
  });
  const imported = Effect.fn("GitHubIssuesService.imported")(function* (issue: GitHubIssue) {
    const item = yield* workItems.findByResource(resource(issue));
    return { workItemId: item?.id ?? null, localStatus: item?.status ?? null };
  });
  const importIssue = Effect.fn("GitHubIssuesService.importIssue")(function* (
    repo: GitHubTrackedRepository,
    issue: GitHubIssue,
  ) {
    if (yield* workItems.isResourceDeleted(resource(issue))) return;
    const existing = yield* workItems.findByResource(resource(issue));
    if (existing) return;
    const id = WorkItemId.make(`github:${repositoryNamespace(repo)}:${issue.externalId}`);
    const detached = yield* workItems.get(id).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed(null),
      ),
    );
    if (detached) {
      yield* workItems
        .mutate({
          kind: "attachResource",
          id,
          commandId: `reattach:${id}:${detached.revision}`,
          expectedRevision: detached.revision,
          resource: resource(issue),
        })
        .pipe(Effect.mapError((error) => fail("invalid", error.message)));
      return;
    }
    yield* workItems
      .mutate({
        kind: "create",
        id,
        commandId: `import:${id}`,
        source: "github_issue",
        title: issue.title,
        fields: { body: issue.body, projectId: repo.projectId, repository: repo.repository },
        resource: resource(issue),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // A manual attachment may win the race against this import; the unique resource remains authoritative.
            if (yield* workItems.findByResource(resource(issue))) return;
            return yield* fail("invalid", error.message);
          }),
        ),
      );
  });
  const recordComments = Effect.fn("GitHubIssuesService.recordComments")(function* (
    issue: GitHubIssue,
  ) {
    const item = yield* workItems.findByResource(resource(issue));
    if (!item) return;
    yield* sql.withTransaction(
      Effect.forEach(
        issue.comments,
        (comment) =>
          activity.append({
            id: activityId(`github-comment:${item.id}:${repositoryNamespace(issue)}:${comment.id}`),
            workItemId: item.id,
            kind: "github_comment_added",
            source: "github",
            occurredAt: comment.createdAt,
            title: "GitHub comment added",
            summary: comment.body.slice(0, 1000),
            threadId: null,
            url: comment.url,
            details: [{ label: "Author", value: comment.author.slice(0, 500) }],
          }),
        { discard: true },
      ),
    );
  });
  const sync = Effect.fn("GitHubIssuesService.sync")(function* (repo: GitHubTrackedRepository) {
    const started = DateTime.formatIso(yield* DateTime.now);
    // Overlap timestamps because GitHub timestamps have second precision.
    const since = repo.lastSyncedAt
      ? DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(repo.lastSyncedAt), { seconds: 1 }),
        )
      : null;
    const fetched = yield* adapter.list(repo, since);
    const snapshots = new Map<string, GitHubIssue>();
    for (const issue of fetched) {
      const old = snapshots.get(issue.externalId);
      if (!old || old.updatedAt <= issue.updatedAt) snapshots.set(issue.externalId, issue);
    }
    const unavailable = new Map<string, GitHubIssue>();
    const detail = Effect.fn(function* (issue: GitHubIssue) {
      const result = yield* adapter.detail(issue).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      if (result.failure.code !== "not_found") return yield* result.failure;
      unavailable.set(issue.externalId, {
        ...issue,
        lastAttemptAt: started,
        syncStatus: "unavailable",
        syncError: result.failure.message,
      });
      snapshots.delete(issue.externalId);
      return null;
    });
    const rows = yield* sql<{ record_json: string }>`SELECT i.record_json FROM github_issues i
      JOIN work_item_resources r ON r.source='github_issue' AND r.namespace=i.namespace AND r.external_id=i.external_id
      WHERE i.namespace=${repositoryNamespace(repo)}`;
    // Refresh imported issues individually, including comments edited/deleted without a list timestamp change.
    for (const row of rows) {
      const issue = yield* decodeIssue(row.record_json);
      const updated = yield* detail(issue);
      if (updated) snapshots.set(issue.externalId, updated);
    }
    // A rule applies to any matching cached open issue, including rules configured after the first sync.
    const oldRows = repo.importLabels.length
      ? yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM github_issues WHERE namespace=${repositoryNamespace(repo)} AND state='open'`
      : [];
    for (const row of oldRows) {
      const issue = yield* decodeIssue(row.record_json);
      if (
        !unavailable.has(issue.externalId) &&
        !snapshots.has(issue.externalId) &&
        issue.labels.some((label) => repo.importLabels.includes(label))
      )
        snapshots.set(issue.externalId, issue);
    }
    for (const [id, issue] of snapshots) {
      if (
        issue.state === "open" &&
        issue.labels.some((label) => repo.importLabels.includes(label)) &&
        !(yield* workItems.findByResource(resource(issue)))
      ) {
        const updated = yield* detail(issue);
        if (updated) snapshots.set(id, updated);
      } else if (issue.commentsFetchedAt === null) {
        const previous = yield* cached(issue);
        if (previous)
          snapshots.set(id, {
            ...issue,
            comments: previous.comments,
            commentsFetchedAt: previous.commentsFetchedAt,
          });
      }
    }
    let stale = 0;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const snapshot of snapshots.values()) {
          const previous = yield* cached(snapshot);
          if (previous && snapshot.updatedAt < previous.updatedAt) {
            stale++;
            yield* saveIssue({
              ...previous,
              lastAttemptAt: started,
              syncStatus: "error",
              syncError: "GitHub returned an older snapshot. Retry the refresh.",
            });
            continue;
          }
          const issue: GitHubIssue = {
            ...snapshot,
            lastSyncedAt: started,
            lastAttemptAt: started,
            syncStatus: "ready",
            syncError: null,
          };
          // Cache, task receipts, imports and cursor either commit together or remain unchanged.
          if (previous) yield* workItems.refreshExternal(resource(issue), previous, issue);
          yield* saveIssue(issue);
          if (
            issue.state === "open" &&
            issue.labels.some((label) => repo.importLabels.includes(label))
          )
            yield* importIssue(repo, issue);
          yield* recordComments(issue);
        }
        for (const issue of unavailable.values()) yield* saveIssue(issue);
        yield* saveRepo({
          ...repo,
          lastSyncedAt: stale ? repo.lastSyncedAt : started,
          lastAttemptAt: started,
          syncStatus: unavailable.size || stale ? "partial" : "ready",
          syncError: stale
            ? "GitHub returned older snapshots. Cached content and the sync cursor were retained; retry the sync."
            : unavailable.size
              ? `${unavailable.size} issue(s) unavailable. Cached tasks were retained; refresh after restoring access.`
              : null,
        });
      }),
    );
    yield* Effect.logInfo("GitHub issue sync completed").pipe(
      Effect.annotateLogs({
        repository: repositoryNamespace(repo),
        refreshed: snapshots.size,
        unavailable: unavailable.size,
      }),
    );
  });
  const mutate = Effect.fn("GitHubIssuesService.mutate")(
    function* (raw: GitHubIssuesMutation) {
      const decoded = yield* decodeMutation(raw).pipe(
        Effect.mapError(() =>
          fail("invalid", "Enter a valid GitHub host, owner/repository and issue number."),
        ),
      );
      const input = {
        ...decoded,
        host: decoded.host.toLowerCase(),
        repository: decoded.repository.toLowerCase(),
      };
      if (input.kind === "configure") {
        const repos = yield* repositories();
        const previous = repos.find(
          (repo) => repositoryNamespace(repo) === repositoryNamespace(input),
        );
        if (
          (!previous || previous.discoveredByAccount) &&
          repos.filter((repo) => !repo.discoveredByAccount).length >= 50
        )
          return yield* fail("invalid", "You can track up to 50 repositories per environment.");
        if (input.projectId) {
          const projects =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${input.projectId} AND deleted_at IS NULL`;
          if (!projects.length) return yield* fail("invalid", "Choose an available project.");
        }
        yield* saveRepo({
          ...previous,
          discoveredByAccount: false,
          host: input.host,
          repository: input.repository,
          projectId: input.projectId,
          importLabels: [
            ...new Set(input.importLabels.map((label) => label.trim()).filter(Boolean)),
          ],
          lastSyncedAt: previous?.lastSyncedAt ?? null,
          syncError: previous?.syncError ?? null,
        });
        return;
      }
      const repo = yield* tracked(input);
      if (input.kind === "untrack") {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM github_issues WHERE namespace=${repositoryNamespace(repo)}`;
            yield* sql`DELETE FROM github_tracked_repositories WHERE namespace=${repositoryNamespace(repo)}`;
          }),
        );
        return;
      }
      if (input.kind === "sync") {
        yield* sync(repo).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failure = storageError(error);
              yield* saveRepo({
                ...repo,
                lastAttemptAt: DateTime.formatIso(yield* DateTime.now),
                syncStatus: "error",
                syncError: failure.message,
              });
              yield* Effect.logWarning("GitHub issue sync failed; previous snapshot retained").pipe(
                Effect.annotateLogs({ repository: repositoryNamespace(repo), code: failure.code }),
              );
              return yield* failure;
            }),
          ),
        );
        return;
      }
      const previous = yield* cached(input);
      const at = DateTime.formatIso(yield* DateTime.now);
      const result = yield* adapter.detail({ ...repo, number: input.number }).pipe(Effect.result);
      if (result._tag === "Failure") {
        if (previous)
          yield* saveIssue({
            ...previous,
            lastAttemptAt: at,
            syncStatus: result.failure.code === "not_found" ? "unavailable" : "error",
            syncError: result.failure.message,
          });
        yield* Effect.logWarning("GitHub issue refresh failed; cached task retained").pipe(
          Effect.annotateLogs({
            repository: repositoryNamespace(repo),
            number: input.number,
            code: result.failure.code,
          }),
        );
        return yield* result.failure;
      }
      if (previous && result.success.updatedAt < previous.updatedAt) {
        yield* saveIssue({
          ...previous,
          lastAttemptAt: at,
          syncStatus: "error",
          syncError: "GitHub returned an older snapshot. Retry the refresh.",
        });
        return;
      }
      const issue: GitHubIssue = {
        ...result.success,
        lastSyncedAt: at,
        lastAttemptAt: at,
        syncStatus: "ready",
        syncError: null,
      };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (previous) yield* workItems.refreshExternal(resource(issue), previous, issue);
          yield* saveIssue(issue);
          if (input.kind === "import") yield* importIssue(repo, issue);
          yield* recordComments(issue);
        }),
      );
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(SubscriptionRef.update(changes, (n) => n + 1)),
    Effect.ensuring(workItems.notifyChange),
  );
  const ingestAssigned = Effect.fn("GitHubIssuesService.ingestAssigned")(
    function* (account: GitHubAccount, snapshots: ReadonlyArray<GitHubIssue>) {
      const existingRepos = new Map(
        (yield* repositories()).map((repo) => [repositoryNamespace(repo), repo]),
      );
      for (const snapshot of snapshots) {
        if (
          snapshot.host !== "github.com" ||
          snapshot.state !== "open" ||
          !snapshot.assignees.some((login) => login.toLowerCase() === account.login.toLowerCase())
        )
          continue;
        const namespace = repositoryNamespace(snapshot);
        let repo = existingRepos.get(namespace);
        if (!repo) {
          repo = {
            host: snapshot.host,
            repository: snapshot.repository,
            projectId: null,
            importLabels: [],
            lastSyncedAt: null,
            syncError: null,
            discoveredByAccount: true,
          };
          yield* saveRepo(repo);
          existingRepos.set(namespace, repo);
        }
        const previous = yield* cached(snapshot);
        const issue: GitHubIssue =
          previous && previous.updatedAt > snapshot.updatedAt
            ? previous
            : {
                ...snapshot,
                comments: previous?.comments ?? [],
                commentsFetchedAt: previous?.commentsFetchedAt ?? null,
                lastSyncedAt: account.lastSyncedAt ?? null,
                ...(account.lastAttemptAt ? { lastAttemptAt: account.lastAttemptAt } : {}),
                syncStatus: "ready",
                syncError: null,
              };
        if (previous) yield* workItems.refreshExternal(resource(issue), previous, issue);
        yield* saveIssue(issue);
        yield* importIssue(repo, issue);
      }
      const record = yield* encodeAccount(account);
      yield* sql`INSERT INTO github_account(id,record_json) VALUES(1,${record}) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json`;
    },
    sql.withTransaction,
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(SubscriptionRef.update(changes, (n) => n + 1)),
    Effect.ensuring(workItems.notifyChange),
  );
  const list = Effect.fn("GitHubIssuesService.list")(
    function* (raw: GitHubIssuesListInput) {
      const input = yield* decodeList(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid issue filters.")),
      );
      // Account-discovered issues become Work tasks directly; the repository browser stays opt-in.
      const conditions = [sql`coalesce(json_extract(t.record_json, '$.discoveredByAccount'),0)=0`];
      if (input.repository) conditions.push(sql`i.namespace=${input.repository.toLowerCase()}`);
      if (input.projectId)
        conditions.push(sql`json_extract(t.record_json, '$.projectId')=${input.projectId}`);
      if (input.state !== "all") conditions.push(sql`i.state=${input.state ?? "open"}`);
      if (input.label)
        conditions.push(
          sql`EXISTS (SELECT 1 FROM json_each(i.record_json, '$.labels') WHERE value=${input.label})`,
        );
      if (input.assignee)
        conditions.push(
          sql`EXISTS (SELECT 1 FROM json_each(i.record_json, '$.assignees') WHERE lower(value)=lower(${input.assignee}))`,
        );
      const where = sql.and(conditions);
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT json_set(json_remove(i.record_json, '$.body', '$.comments'),
        '$.workItemId', r.work_item_id, '$.localStatus', w.status) AS record_json
        FROM github_issues i JOIN github_tracked_repositories t ON t.namespace=i.namespace
        LEFT JOIN work_item_resources r ON r.source='github_issue' AND r.namespace=i.namespace AND r.external_id=i.external_id
        LEFT JOIN work_items w ON w.id=r.work_item_id
      WHERE ${where} ORDER BY i.updated_at DESC, i.namespace, i.number LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
      const counts = yield* sql<{
        total: number;
      }>`SELECT count(*) AS total FROM github_issues i JOIN github_tracked_repositories t ON t.namespace=i.namespace WHERE ${where}`;
      const items = yield* Effect.forEach(rows, (row) => decodeSummary(row.record_json));
      const accounts = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM github_account WHERE id=1`;
      const account = accounts[0] ? yield* decodeAccount(accounts[0].record_json) : null;
      return {
        account,
        repositories: (yield* repositories()).filter((repo) => !repo.discoveredByAccount),
        items,
        total: counts[0]?.total ?? 0,
      };
    },
    sql.withTransaction,
    Effect.mapError(storageError),
  );
  const get = Effect.fn("GitHubIssuesService.get")(function* (raw: GitHubIssueReference) {
    const ref = yield* decodeReference(raw).pipe(
      Effect.mapError(() => fail("invalid", "Invalid issue reference.")),
    );
    const issue = yield* cached(ref);
    if (!issue) return yield* fail("not_found", "Sync or refresh this issue first.");
    return { ...issue, ...(yield* imported(issue)) };
  }, Effect.mapError(storageError));
  return {
    ingestAssigned,
    notifyChange: SubscriptionRef.update(changes, (n) => n + 1),
    mutate,
    list,
    get,
    subscribe: (input: GitHubIssuesListInput) =>
      Stream.merge(SubscriptionRef.changes(changes), workItems.changes).pipe(
        Stream.mapEffect(() => list(input)),
      ),
  };
});
export class GitHubIssuesService extends Context.Service<
  GitHubIssuesService,
  Effect.Success<typeof make>
>()("t3/integrations/github/GitHubIssuesService") {}
