# Agent orchestration

Work connects a reviewed task to T3's existing agent threads, worktrees and change review.
Assigning an agent or importing external context does not start execution.

## Plan with an agent

Open a task and select the **Plan** tab. Review its preselected repository, choose an available
provider and model, optionally add constraints, and start planning. A matching GitHub repository
is preselected when available. No separate project assignment or move to Ready is needed. You can close
the view or disconnect while it runs. The result moves the item to **Awaiting Approval**, shown
under In Progress, and is recorded in a dedicated thread attached to the WorkItem.

Planning inspects the current project workspace, including uncommitted files. It does not
check out the WorkItem's requested branch. The agent first selects files from the repository
inventory, then reviews bounded source snapshots, repository instructions, the WorkItem and
saved GitHub issue context. The plan lists the files actually inspected; oversized files,
ignored files, secrets and links outside the project are excluded. Use guidance and regenerate
if the agent needs different context. Expand **GitHub comments** in a task to load its discussion; use
**Refresh comments** to fetch newer discussion while the task is open.

Protected planning supports Codex through its read-only generation sandbox and Claude,
OpenCode and Antigravity through their tool-disabled generation paths. Cursor and Grok
remain unavailable for this workflow. Provider calls run outside the repository, and
planning does not modify its files.

Review the summary, proposed changes, files, steps, tests, risks, questions and complexity.
Edit the plan, approve it, or reject it and regenerate with new guidance. Edits clear approval;
changes to the WorkItem after approval require a new review before execution. Generated and
edited revisions are retained. Approval returns the WorkItem to Ready and does not start coding.
Use **Approve & Execute** when you are ready to implement the reviewed plan.

Cancel a running plan to return the item to Ready. If the provider fails or the server restarts,
the item returns to Ready with an explanation; regenerate to retry. A server restart never
silently repeats a provider call.

## Execute a task

Open a task and select the **Execute** tab. Review its repository, choose an agent and model, then execute.
A plan is optional: the prompt is generated from the task title and description. Add
**Additional guidance** only if you have extra instructions. Direct execution can start from
Inbox, Backlog, Ready, Awaiting Approval or Blocked. The selected project is assigned when execution starts.

To execute a saved plan, select **Use the existing plan** and provide validation commands.
**Approve & Execute** approves the current draft or checks its existing approval. Changing
the task after approval requires editing or regenerating the plan and approving it again.

Execution creates a dedicated branch and worktree from the WorkItem's branch, or the current
commit when no branch is set. For manual execution, the branch is published to the remote before
the agent starts; GitHub uses your connected account. Saved clones are reused across issues.
Commit or stash changes in the project checkout first. Existing
project setup runs before the agent starts; a failed setup blocks the WorkItem. Execution
supports available T3 providers through their normal runtime and keeps provider approvals
in the agent thread. Planning's provider restrictions do not restrict execution selection.

The WorkItem remains **In Progress** through implementation and validation. Its execution panel
shows activity, branch, timestamps, checkpoint changes and validation output. **Open Agent
Thread**, **Open Worktree**, **View Changes** and **Terminal output** open the existing T3
surfaces on the selected environment. Open Worktree browses the worktree's files inside T3,
including when connected remotely.

An agent must explicitly report completion of the requested scope. Once its turn and change
snapshot are complete, the server runs any configured validation commands in the worktree.
Each command has a ten-minute limit; output is bounded and saved. These commands are optional
for direct execution; the agent is still asked to run appropriate checks and report results.
A completed implementation with all configured checks passing stays in **In Progress** until a PR is opened, then moves to **Review**. A question, failed turn, failed change snapshot or
failed validation moves to **Blocked** with a reason. No pull request is created automatically.

**Stop execution** cancels preparation or validation, or requests a stop through the provider.
The worktree and branch are retained. If the provider cannot stop, the panel shows the failure
and allows another stop attempt. A server restart stops unfinished execution and marks it
Blocked; it never silently repeats agent work or validation commands.

For a retry, inspect the retained thread and worktree, move the WorkItem to Ready, then edit
or regenerate the plan and review it again. A new execution gets a new worktree. Uncommitted
changes in the previous worktree are retained there, not copied into a retry. The server checks
that the execution worktree and branch still exist before handoff and validation. If either
was deleted or changed, restore it or start a new execution. Recovery never removes retained files.

Validation commands and configured project setup scripts execute on the environment host.
They are explicitly authorized commands, outside the provider's tool-approval prompts.
Review them as code before starting a run or trusting an automation; a provider permission
mode does not sandbox these commands. Completion markers and passing tests help coordinate
work but do not replace reviewing the resulting changes.

To publish the initial result, follow [Create and review a pull request](github-integration.md#create-and-review-a-pull-request).

## Address PR review feedback

The WorkItem's **Review feedback** panel records review requests, decisions, new or edited
comments, and changed check results. It follows T3's existing PR synchronization; use
**Refresh review feedback** to request current information immediately. The latest snapshot
and activity remain available when the host cannot be reached.

Choose **Send Changes to Agent**, review the comments and failed checks, add guidance if
needed, and review the validation commands. **Resume Agent, Validate & Push** starts another
cycle on the same WorkItem, original agent thread and worktree. The original provider and
model must still be available, and the thread must be restored and idle. New feedback or
WorkItem edits invalidate an open confirmation form so you can review them before starting.

The item returns to In Progress. Once the agent completes the requested fixes, the server runs
validation and uses the existing Git workflow to commit and push to the same PR. Only passing
validation proceeds to push; successful pushes return the item to Review. No second WorkItem
or PR is created. Activity records each cycle and its outcome.

Use **Stop execution** while the agent or validation is running. Commit/push cannot be stopped
from this panel once publication begins. Failed validation, failed pushes and server restarts
leave the item Blocked with an explanation and retain the thread/worktree. Inspect that state
before explicitly starting another cycle; interrupted work never repeats automatically.
Incomplete or oversized host feedback blocks automatic handoff instead of silently omitting
comments; use the existing agent thread to handle those cases manually.

A confirmed PR merge moves the WorkItem to Done and stores its completion time. Merely
queuing a merge or enabling auto-merge does not complete it. If a review cycle is active when
merge is observed, T3 ends that cycle; a late agent result cannot reopen the completed item.

## Provider support

| Workflow                    | Supported providers                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Protected planning          | Claude, OpenCode, Antigravity when installed, enabled and available                                   |
| Execution and review cycles | Available Codex, Claude, Cursor, Grok, OpenCode and Antigravity instances through T3's normal runtime |

Protected planning is capability-gated on the server. Adding another provider requires an
existing text-generation path that enforces tool restrictions; prompting it to be read-only
is insufficient. See [the architecture constraints](project-management-architecture.md#planning-is-a-restricted-text-generation-operation).
