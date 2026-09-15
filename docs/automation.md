# Automations

Open **Settings → Automation settings** on web or desktop, or **Settings → Automations**
on mobile. You can also open **Work → Automations**. Select the environment, create a rule,
choose a trigger and optional conditions, then add actions in order. New rules are disabled;
enable a saved rule to respond to future events. Rules run on the server while it is online,
even when clients are closed. GitHub and Slack triggers arrive when those sources are synced.

For example, trigger on **GitHub labels changed**, require the exact label `agent-ready`,
and add **Create/import WorkItem**, **Generate plan**, and **Create notification**.
Imports use the project assigned to the tracked repository. Planning moves inbox or backlog
items to Ready and requests a plan using the selected provider and model. Planning finishes
separately; review its result before explicitly approving it. A separate trusted rule can
execute that approved plan, as described below. Automations never approve plans or merge PRs.

All conditions must match. Label conditions match the labels remaining after a change;
**GitHub issue first synced** also includes existing issues encountered for the first time.
Status and linked-thread conditions require an imported WorkItem. Actions stop at the first
failure. Automation-generated changes do not trigger more rules.

Each rule shows its last execution; **History** shows previous runs and how many actions
completed. Editing, disabling, or deleting a rule cancels queued actions and follow-ups, but
does not interrupt an agent already working. Use **Stop all automations** to stop that work.
History remains available. Enabling or editing never replays earlier events. If a restart interrupts an action,
inspect the WorkItem before making further changes: that action may have completed, so it is
not automatically repeated. Notification actions follow the environment’s delivery settings.

### Trusted execution

To execute approved work automatically, create a separate rule with **Plan approved** as its
trigger and add **Execute approved WorkItem**. Configure its execution safeguards, explicitly
check **Trust this rule**, then enable it. Existing rules never gain execution trust by updating
the server. Only one execution action is allowed per rule; planning and execution belong in
separate rules so a person can review and approve each plan.

Specify allowed repositories as `host/owner/repository`, allowed issue labels, and allowed
providers. Execution requires an open imported GitHub issue with at least one allowed label
in the latest synced data, assigned to that repository’s tracked project. The server also
checks the checkout’s actual `origin`. Changing a WorkItem after approval requires approving
its current plan again.

The simultaneous-run limit applies to each rule. Additional runs wait for capacity and are
checked again before starting. **Approval required** preserves provider approval prompts;
**Accept edits; keep other approvals** uses T3 Code’s existing edit-approval mode (Codex uses
workspace-write with user approval for other requests). Neither option grants full access.
A run may wait for input in its agent thread.

Validation is required by default. Enter one command per line; disabling that requirement
explicitly permits execution without validation commands. Required PR creation happens only
after successful execution and validation; later rule actions, such as notifications, wait for
that result. PRs remain open for review and are never merged automatically. The existing
validation-command timeout still applies; there is no separate whole-execution timeout.

**Stop all automations** immediately pauses new admissions, cancels queued actions and
follow-ups, and requests stops for automation-owned agents and plans. It leaves manually
started work alone. The pause survives restarts. Check the Work queue and agent threads for
stop progress or failures, and retry Stop all if needed. Already completed external actions,
including a PR created just before stopping, remain. **Resume automations** handles future
events only; it does not restart interrupted work or replay events received while paused.

## Permissions and operating limits

Rules and emergency controls require the environment's orchestration-operate permission.
Read-only clients can inspect rules and history. Trust is granted by an operator for the
whole environment; this is not a separate per-user role or approval system. Keep operate
access limited to people who may run commands on that environment.

There are no additional required automation environment variables. Import, status, provider
assignment and planning actions use the same validated services as manual work. GitHub labels,
Slack messages and review comments supply context; they cannot create trust or approve a plan.
Allowlist checks use the latest saved issue state, not a live GitHub request at execution time.
Sync before relying on changed labels or permissions. Failed/unavailable snapshots block
trusted admission, but there is no maximum age for an otherwise successful snapshot.

Validation commands and project setup scripts run on the host, outside provider tool approvals.
A trusted rule can be configured to create a PR after validation; it cannot approve its own
plan or merge that PR. Review [the agent lifecycle](agent-orchestration.md) and
[architecture boundaries](project-management-architecture.md) before extending rule actions.
