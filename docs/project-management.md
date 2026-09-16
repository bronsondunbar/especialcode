# Project management

This fork adds an environment-owned Work queue around T3 Code's existing coding-agent
experience. A task can begin as a manual WorkItem, GitHub issue or Slack message, acquire
a reviewed plan, execute in a dedicated worktree, and progress through PR review to completion.
Web, desktop and mobile use the same server state. The upstream published apps and `t3`
package do not necessarily contain this fork's features; run this checkout to use them.

## Start locally

Use Node matching the root `package.json` engine (`^24.13.1`), install Vite+ as described in
[the README](../README.md#install-vp), and run from this checkout:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the runner. Add a project rooted at a local repository on
that environment and configure an installed provider in Settings. Open **Work**, create a
task, assign its project, move it to Ready, and start a plan. Review and approve the plan
before executing it. See [Agent orchestration](agent-orchestration.md).

For Electron, use `vp run dev:desktop`. Native mobile development follows the
[mobile README](../apps/mobile/README.md). Remote clients connect to the machine that owns
the repository, credentials and Work state. In development, leave `VITE_HTTP_URL` and
`VITE_WS_URL` unset so connections continue using the current origin.

State follows the existing dev runner: a linked worktree uses `.t3/userdata`; the main
checkout normally uses `~/.t3/dev/userdata`. An explicit `--home-dir` selects disposable state.
Never use the live `~/.t3/userdata` for development. See the
[development runbook](operations/development.md) for isolation and pairing details.

## Configure integrations and delivery

| Feature       | Configuration                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub        | Connect an account in Work to create tasks from assigned issues automatically; use `gh` for PR operations. See [GitHub integration](github-integration.md).         |
| Slack         | Configure the three server variables below, then connect a workspace to import direct mentions automatically. See [Slack integration](slack-integration.md).        |
| Notifications | Set environment categories/delivery preferences and enable native alerts on each device. See [Notifications](notifications.md).                                     |
| Automation    | Save rules, review conditions/actions, then enable them. Execution also requires explicit trust, allowlists and an approved plan. See [Automations](automation.md). |

Only Slack adds required environment variables, and only when connecting Slack:

| Variable                     | Purpose                                                                | Secret? |
| ---------------------------- | ---------------------------------------------------------------------- | ------- |
| `T3CODE_SLACK_CLIENT_ID`     | Slack app OAuth client ID                                              | No      |
| `T3CODE_SLACK_CLIENT_SECRET` | Slack app OAuth client secret                                          | Yes     |
| `T3CODE_SLACK_REDIRECT_URI`  | Registered HTTPS callback ending in `/api/integrations/slack/callback` | No      |

Set them in the server process environment or a gitignored local env file used by the dev
runner. Restart the server after changing them. Do not put secrets in `VITE_*` variables,
URLs, committed files or screenshots. OAuth access/refresh tokens live in the server secret
store and are not returned by the integration RPCs. Work, planning, the notification inbox
and automation add no required environment variables of their own. Existing provider and
remote-connection configuration remains unchanged.

## Workflow guides

- [Work items](work-items.md): task fields, queue states, relationships and activity.
- [GitHub integration](github-integration.md): authentication, issue sync, import and PR creation.
- [Slack integration](slack-integration.md): OAuth, mentions, thread context and task conversion.
- [Agent orchestration](agent-orchestration.md): planning, approval, execution and review cycles.
- [Notifications](notifications.md): durable inbox, preferences and device delivery.
- [Automations](automation.md): triggers, run history, trusted execution and emergency stop.

## Dashboard

Open **Work → Dashboard** for an overview across projects in the selected environment. On
web and desktop, **Open developer dashboard** in the command palette opens it directly.
Filter by project, exact repository (`owner/repository`), source, agent, status or priority.

Needs Attention highlights agent questions, failed work, pending plan approvals, and PR
review or check issues. Ready contains tasks with a current approved plan and an assigned
project. Running, Review, Blocked and Inbox show other work awaiting progress. A task can
appear in more than one section. Select a section to page through all matching tasks.
Recent Activity follows the same filters and includes completed work.

Open a task's plan, agent thread or activity to take action. Use **Work Queue** to edit tasks.
PR information reflects the latest sync; refresh it in the PR detail view when newer remote
results are needed. Dashboard Refresh reloads saved state.

## Architecture and modules

The server owns coordination and persistence. Typed RPCs in `packages/contracts` serve
clients through the existing environment connection runtime. Web components also serve the
Electron renderer; React Native has its own views. Notifications add a narrow desktop IPC
bridge for native delivery. There is no separate project-management server or agent process
manager.

| Module                                                            | Responsibility and reused boundary                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Work services](../apps/server/src/workItems/)                    | WorkItems, bounded dashboard/activity queries, plan approvals, execution and PR review coordination |
| [GitHub integration](../apps/server/src/integrations/github/)     | Assigned-issue task imports and optional repository sync, using shared rate limits                  |
| [Slack integration](../apps/server/src/integrations/slack/)       | Read-only Slack API operations and OAuth; credentials use the existing server secret store          |
| [Notifications](../apps/server/src/notifications/)                | Normalize committed work/agent/integration events into a durable inbox                              |
| [Automations](../apps/server/src/automations/)                    | Match future events, record runs and invoke the existing Work services                              |
| [Client state](../packages/client-runtime/src/state/workItems.ts) | Environment-scoped calls and live subscriptions shared by web and mobile                            |

Provider adapters continue owning provider processes, credentials, sessions and permissions.
Work execution dispatches existing orchestration commands; the decider, projectors, reactors
and checkpoints keep their existing roles. PR creation/review delegates to the existing Git
workflow and PullRequestService. Protected planning extends existing text generation with a
restricted operation. See [architecture constraints](project-management-architecture.md)
for the boundaries that must survive future changes.

## Data model

Migrations 052–064 add domain tables to the environment's existing SQLite database. No second
database or network service is required. Work state is authoritative in its own tables;
Work activity and mutation receipts do not replace the orchestration event log.

| Record group               | Durable state                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| WorkItems                  | Identity, title/body, local workflow state, source, priority, project/thread/parent links, revision and lifecycle timestamps      |
| Resources and receipts     | Unique source/namespace/external-ID ownership, command deduplication and revision-safe mutations                                  |
| Plans                      | Current structured plan, revision history, approval tied to an exact WorkItem revision, generation outcome and transcript thread  |
| Executions and PR review   | Retained branch/worktree/thread, validation results, execution/review cycles, linked PR and saved feedback                        |
| External snapshots         | Tracked GitHub repositories/issues/comments and Slack workspaces/channels/messages; sync attempt, last success and error metadata |
| Activity and notifications | Stable activity/event identities, consumer cursors, notification read state and environment preferences                           |
| Automation                 | Revisioned rules, activation boundaries, events, runs, action progress, ownership and durable pause control                       |

Local workflow state is independent of external issue state. Archiving retains records and
references. Retrying an import reuses its source identity; retrying a mutation does not bypass
revision validation. No automatic retention policy removes old Work history or abandoned
execution worktrees.

## Lifecycle boundaries

**Integration:** fetch bounded source data, validate it, then commit snapshots and any Work
changes. GitHub batch refreshes commit task updates and their cursor together; missing issues
retain their cache while other issues can refresh. Slack refreshes preserve local edits and archived task context. Failures expose cached data and recovery actions instead of deleting tasks.
External text is context, not authorization.

**Agent:** generate a restricted plan, review/edit it, approve its current revision, then
explicitly execute or let an already trusted rule admit it. Execution prepares a worktree and
uses an ordinary agent thread. Completion requires the expected completed turn/checkpoint,
a completion marker and successful required validation. Review cycles reuse the thread and
worktree, validate, then commit/push to the existing PR. Confirmed merges complete work.
Interrupted calls are retained for inspection rather than replayed after restart.

**Notification:** committed Work receipts, agent events and integration events receive stable
identities, pass through category/delivery preferences, and become durable notifications.
Clients subscribe to the environment inbox and apply device delivery preferences. Read state
is shared; reconnect does not replay the whole inbox as native alerts. Delivery actions open
existing task, thread, diff and PR surfaces rather than creating another execution path.

**Automation:** a future source event matches an enabled rule revision, producing one durable
run. Conditions must all match; actions execute in order through the same services used by
manual work. Automation-generated changes do not recursively trigger rules. Trusted execution
adds approval, allowlist, repository-origin, concurrency and validation checks. Stop-all pauses
new work durably and requests stops for automation-owned work. Resume observes future events;
it does not replay interrupted actions.

## Known limitations

- Work and its shared read state are environment-local, not a cross-environment team workspace.
  There is no per-user assignment/permission system separate from existing environment scopes.
- Connected GitHub accounts poll assigned issues every five minutes while the environment runs.
  Connected Slack workspaces also poll direct mentions automatically. Repository-wide GitHub
  sync and optional Slack channel browsing are manual. There is no webhook receiver or full Slack archive. PR feedback uses T3's existing refresh paths.
- Protected planning currently supports Claude, OpenCode and Antigravity. Context is bounded,
  uses the current checkout rather than the requested execution branch, and can omit files.
  Filename exclusions are not a general secret scanner; review repository content before sharing.
- A successful cached issue has no maximum age for automation admission. Sync after external
  changes; allowlists and provider permissions cannot guarantee that an agent's implementation
  is correct. Host validation/setup commands require operator review.
- Native web/desktop alerts need a connected client. Work does not introduce background mobile
  push delivery. External-service access and OS notification permissions still affect delivery.
- Validation commands have timeouts, but there is no whole-execution deadline. Interrupted runs,
  retained worktrees and partial external publication require explicit inspection and recovery.
- Snapshot/page limits fail visibly or expose pagination. There is no automatic task-history
  pruning or one-click bulk worktree cleanup.

## Future improvements

Prioritize source freshness with an explicit scheduling/webhook policy before expanding
unattended execution. Add protected planning to other providers only after their existing
runtime can enforce equivalent restrictions. Consider whole-run deadlines and an inspectable
worktree retention/cleanup policy. Extend native mobile notification delivery through T3's
existing push infrastructure if Work alerts are needed while the app is closed.

Keep future changes at these boundaries: reuse Git/PR and provider services, retain server-side
admission checks, and prove recovery/idempotence with behavioral tests. New dashboard views or
rule actions should not introduce another runtime or a second source of task truth.
