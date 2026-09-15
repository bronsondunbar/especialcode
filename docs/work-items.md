# Work items

Open **Work** from the sidebar or search for **Open work queue** in the command palette.
On mobile, open **Settings → Work**. Choose the environment that owns the task; tasks and
project assignments stay on that environment, including when you connect remotely.

Use **Create task** to add a title and optional description, project and agent assignment.
New tasks enter Inbox. Edit a task to update its context, attach an existing thread, or
set a parent task by its ID. A thread and parent must belong to the task's project.
Assigning an agent records your choice; it does not start the agent.

Search titles and descriptions, or filter by project, priority and source. Inbox,
Backlog, Ready, Running, Review and Done organize the queue. Backlog also includes
blocked and cancelled tasks, with their exact status shown. A blocked task needs a reason.
Planning appears under Running while the agent prepares a plan.

Choose a status and press **Move** to change it. To reopen a completed or cancelled task,
move it to Inbox, Backlog or Ready first. **Archive** hides a task without deleting its
thread or worktree; find it under Archived and choose **Restore** to bring it back.

Changes appear on other connected clients. If an edit conflicts with a newer change,
cancel the edit and open it again to load the latest version before saving. Full
descriptions are retained even when the queue shows only a preview.

## Activity timeline

Choose **Activity** on a Work queue item, or open its plan/execution details and scroll to
**Activity**. Web, desktop and mobile show the same history for that environment, newest
first. Use **Older** and **Newer** to page through history; **Latest activity** returns to
live updates. Activity remains available for completed and archived tasks.

The timeline combines task imports and edits, source attachments, planning and execution,
validation results, commits and PR review activity. **Open source** follows the original
Slack message, GitHub comment or PR. **Open agent thread** and **Open changes** take you to
the detailed conversation and change review. Entries contain short summaries, not raw logs.
Validation output remains in execution details.

Existing task receipts, cached GitHub comments and saved validation results are included
when the environment updates. New milestones appear as work runs or sources are refreshed;
the timeline cannot reconstruct events that were never recorded. Browsing older pages keeps
them stable while new activity arrives. Notification preferences do not hide timeline events.

## Related workflows

Use the [dashboard](project-management.md#dashboard) to find work needing attention.
Import context from [GitHub](github-integration.md) or [Slack](slack-integration.md),
then [plan, approve and execute](agent-orchestration.md). Follow results in
[Notifications](notifications.md).
