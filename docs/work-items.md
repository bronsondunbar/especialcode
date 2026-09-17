# Work items

Open **Dashboard** from the sidebar or search for **Open queue** in the command palette.
On mobile, open **Settings → Dashboard**. Choose the environment that owns the task; tasks and
project assignments stay on that environment, including when you connect remotely.

Use **Create task** to add a title and optional description, project and agent assignment.
New tasks enter Inbox. Edit a task to update its context, attach an existing thread, or
set a parent task by its ID. A thread and parent must belong to the task's project.
Assigning an agent records your choice; it does not start the agent.

Search titles and descriptions, or filter by project, priority and source. The queue has
**Inbox**, **In Progress**, **Review**, **Done** and **Archived** views. Inbox includes tasks
in Backlog or Ready. In Progress includes planning, tasks awaiting plan approval and blocked
tasks. Done includes cancelled tasks. Each task retains its specific status so you can see
what needs attention. A blocked task needs a reason.

Creating or attaching an agent thread moves its task to **In Progress**. Execution stays there
until a pull request is opened from the linked thread, which moves the task to **Review**.
When that PR is merged, the task moves to **Done**. The environment checks PRs automatically
about once a minute, including when the PR page is closed. Closing a PR without merging it
does not mark the task done. These transitions update the local task, not the GitHub issue.

Choose a status and press **Move** to change it. To reopen a completed or cancelled task,
move it to Inbox, Backlog or Ready first. **Archive** hides a task without deleting its
thread or worktree; find it under Archived and choose **Restore** to bring it back.

Changes appear on other connected clients. If an edit conflicts with a newer change,
cancel the edit and open it again to load the latest version before saving. Full
descriptions are retained even when the queue shows only a preview.

Use **Clear queue** in the queue to archive tasks across every project
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

Choose **New thread** on a task in the dashboard or Queue. Select a repository, agent
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

## Post an update from a thread

Choose **Draft update** in a task-linked thread to prepare a comment from the latest completed
agent response. Select the GitHub issue or Slack conversation, review and edit the text, then
choose **Post GitHub comment** or **Post Slack reply**. Nothing is sent when opening or cancelling
the draft. Long responses are shortened with a notice. You can write an update yourself if the
thread has no completed response.

Posting requires permission to operate on the environment. GitHub credentials need issue-comment
write access; Slack connections need the `chat:write` user scope. If posting cannot be confirmed,
check the original conversation before creating another draft. The app does not automatically
resend uncertain updates.

## Activity timeline

Choose **Activity** on a Queue item, or open its plan/execution details and scroll to
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

Use the [queue](project-management.md#queue) to find tasks and open their linked agent threads.
Import context from [GitHub](github-integration.md) or [Slack](slack-integration.md),
then [plan, approve and execute](agent-orchestration.md). Follow results in
[Notifications](notifications.md).

## Follow Vercel deployments

Open **Work → Vercel**, alongside GitHub and Slack. An environment administrator connects
Vercel once using an access token and its Team ID when applicable. No local repository or
Vercel project is required at this step. The token must have access to the projects and
deployments you want to follow. The connection is saved on the selected environment;
people with read access to that environment can view its deployments and build logs.

When creating a thread from a Work task, select its Vercel project in the new-thread form.
For an ordinary new thread, open **Vercel** in the draft before sending your first message.
Search for a project or leave **Do not link to Vercel** selected. Connecting credentials
does not automatically link threads.
The choice is saved with the draft, including queued mobile drafts.

Threads follow the selected project and their current Git branch automatically. In the web
and desktop sidebar, use **Link Vercel project** beneath the active thread to configure it.
Once linked, **Vercel deployments** opens build/deployment progress, logs and the deployment
URL. On mobile, open **Vercel** from the thread. Use
**Choose project** on an unlinked thread, or **Change project** to choose another project or branch. Leave the branch blank to keep
following the thread's current branch. **Unlink thread** stops following deployments; you can
choose a project again at any time.

The panel refreshes every 15 seconds while open. Follow the latest deployment or select a
recent one, load its build logs, and open its deployment URL. Logs show the latest 200 events,
up to 64,000 characters. Builds are triggered by your existing Vercel workflow; this connection
only monitors them. Disconnecting removes the local connection and thread links without
deleting any Vercel projects or deployments.
