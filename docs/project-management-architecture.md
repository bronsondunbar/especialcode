# Project-management architecture boundaries

The [project-management overview](project-management.md) describes the current product,
modules, data model and lifecycles. This document records constraints that are easy to lose
when extending the system.

## Work coordinates the existing runtime

Work owns task intent, approvals, execution records and source context. It does not own
provider sessions or launch a second provider runtime. [WorkExecutionRuntime](../apps/server/src/workItems/WorkExecutionRuntime.ts)
uses GitWorkflowService, ProjectSetupScriptRunner, OrchestrationEngineService and the existing
projection queries. Completion follows the ordinary turn and checkpoint lifecycle; command
acceptance alone cannot move work to Review.

Keep dependencies directed from Work toward existing runtime services. Provider adapters,
the pure decider and projectors must not acquire dependencies on Work tables, GitHub issue
imports or automation rules. An execution's approval is a Work boundary; actual provider tool
permissions remain at the provider adapter boundary. Validation/setup shell commands are
operator-authorized host commands and are not protected by provider tool approval modes.

## Planning is a restricted text-generation operation

[WorkPlanGenerator](../apps/server/src/workItems/WorkPlanGenerator.ts) uses the configured
provider instance's text-generation closure. It selects repository files in a first pass and
supplies bounded snapshots in a second pass. No ordinary agent turn or worktree setup runs.
Provider calls use a temporary directory outside the project. Claude, OpenCode and Antigravity
advertise this operation through their existing tool-denial paths; other providers do not.
A provider's ordinary read-only mode is not proof that every configured tool is disabled.

Both an inventory path and its resolved symlink target must be permitted. Containment alone
would still allow a harmless alias to disclose an ignored file or `.env` inside the project.
The denylist reduces accidental exposure; it cannot identify every secret embedded in source.
The generator inspects the current workspace, so an execution on another requested branch
can differ from the plan's snapshots. That limitation must stay visible to the operator.

A dedicated history thread stores planning input/output without starting an execution turn.
The structured plan is authoritative; editing it does not rewrite the original transcript.
Approval binds both the plan revision and WorkItem revision. Changes invalidate that approval,
and neither import nor agent assignment nor plan completion is authority to execute.

## Persistence has two distinct authorities

Orchestration retains its event log, pure decider and projected read model. Work uses additive
SQLite tables, command receipts and activity facts in the same environment database. A Work
mutation commits its row, resource ownership, receipt and activity together. Its history is
not an alternative orchestration log and cannot reconstruct provider execution on replay.

External identity is source + namespace + external ID. GitHub issue numbers are display
identifiers; the numeric issue ID owns deduplication. Slack uses workspace/channel/message
identity. Unique resource ownership prevents duplicate tasks across retries and clients.
Local overrides and local workflow state remain independent of external state.

Fetch remote data before a write transaction. Commit GitHub snapshots, task refreshes,
imports and the sync cursor together; failed writes must retain the previous cursor and task
revision. A missing issue can be marked unavailable while other snapshots commit. Older
source snapshots cannot overwrite newer content. Emit change signals after durable state is
available; consumers use saved identities and cursors rather than notification timing as truth.

## Reuse GitHub and PR infrastructure

[GitHubIssuesAdapter](../apps/server/src/integrations/github/GitHubIssuesAdapter.ts) adds issue
endpoints with a shared SourceControlRateLimit budget. Connected account tokens use direct
GitHub REST requests; the CLI remains the fallback for unconnected hosts. Account credentials
are scoped to issue reads and do not change Git transport, PR discovery or merge identity. [WorkPullRequestService](../apps/server/src/workItems/WorkPullRequestService.ts)
and [WorkReviewService](../apps/server/src/workItems/WorkReviewService.ts) delegate publication
and feedback reads to GitWorkflowService and PullRequestService.

After external publication, a local error cannot prove the remote action failed. Retain a
committed PR link even if a later thread-link update fails. Restart recovery must not blindly
replay a commit/push/create request. Likewise, a confirmed merge can complete Work before
optional comment refresh finishes; an old agent result must not reopen merged work.

## Events coordinate delivery and automation

Activity, notifications and rules consume committed facts using stable IDs and durable
cursors. They do not depend on a client remaining online. Notification preferences affect
future delivery, not historical activity. Read state/preferences belong to the environment;
native alert permission and sound additionally belong to the device.

Automation activation starts after already-observed source events. Rules snapshot revisions;
edits/disable/delete cancel queued work and follow-ups. They do not silently stop an agent
already running. Automation-originated mutations must not feed recursive rule chains.

Execution trust is explicit operator configuration. [AutomationExecutionGuard](../apps/server/src/automations/AutomationExecutionGuard.ts)
rechecks pause state, rule revision/trust, approved plan, source/project mapping, allowed
repository/labels/provider and per-rule capacity inside admission. The runtime checks the
actual Git origin before handoff. Public execution RPCs cannot supply internal automation
ownership or gain automation-only validation exceptions. No rule action approves plans or
merges PRs. Read-only clients cannot mutate Work; Slack account/channel administration
requires access-write because it exposes account content to other environment readers.

Stop-all persists the admission pause before requesting provider stops and cancels queued
follow-ups. It targets automation-owned work, leaves manual work alone, and cannot undo an
already committed external action. Resume advances the activation boundary instead of
replaying missed/interrupted work. An ambiguous interrupted action is a recovery state,
not permission to try the same side effect automatically.

## Keep every client on the same boundary

[RPC authorization](../apps/server/src/auth/RpcAuthorization.ts) maps every method to an
existing environment scope. Optional capabilities hide unsupported features on older servers.
Work subscriptions use existing environment connections and initial snapshots on reconnect.
Clients never receive Slack tokens or run GitHub/provider commands locally for remote work.
Web and Electron share views; mobile uses React Native views and shared client state.

New controls must preserve the same server validation from every entry point. A visible
confirmation is useful UX, but an RPC caller can bypass the UI. Revisions, trust, completion,
resource ownership and permissions therefore remain server checks. Keep list payloads bounded
and fetch detailed bodies/history only when the user opens them.
