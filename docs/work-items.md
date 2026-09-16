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

Use **Clear work queue** in the dashboard or queue to archive tasks across every project
and view in the selected environment. Confirm the task count before clearing; filters
do not limit this action. Tasks planning, running or awaiting approval stay in the queue.
Linked threads remain available, and tasks can be recovered through **Archived → Restore**.
New GitHub and Slack tasks can still arrive after clearing.

In **Archived**, choose **Clear archived tasks** to permanently delete archived tasks and
their Work history across the environment. The confirmation shows the count; filters do not
limit deletion. This cannot be undone. Linked threads, files and original GitHub/Slack content
are kept. Existing subtasks are detached from deleted parents. Deleted sources will not be
imported again automatically.

## Start a thread from a task

Choose **New thread** on a task in the dashboard or Work queue. Select a repository, agent
and model, then edit the prompt prepared from the task description and source links.
GitHub tasks suggest a matching local repository when available; you can change it.
Choose a base branch and review the short, editable branch name suggested from the task title.
The new branch gets its own worktree. Turn off new branch creation to use the current checkout.
Repositories must already be added as projects in the selected environment.
**Create thread** links the new thread to the task and opens its composer; press **Send**
when ready to start the agent. The task keeps its current status. If it already had a
linked thread, that previous thread remains available in its project.

For tasks linked to GitHub issues or Slack messages, use **Discussion context** in **New thread**
to fetch and include issue comments or thread replies. Preview the discussion, use **Load more
replies** for longer Slack threads, or **Remove context** to leave it out. Long discussions are
shortened with a notice. The combined prompt stays editable in the chat composer before you
send it; loading context does not post to GitHub or Slack.

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
