# GitHub integration

## Configure access

Install and authenticate the GitHub CLI on the machine running the selected T3 environment:

```sh
gh auth login
gh auth status
```

For GitHub Enterprise, authenticate the selected host with `gh auth login --hostname HOST`.
The account needs access to each tracked repository. PR publication additionally needs the
normal Git push and GitHub PR permissions. Authentication on a client laptop does not grant
access to a remote environment. This integration adds no required GitHub environment variable;
it reuses T3's existing GitHub CLI configuration. Keep credentials on the server.

## Import and sync issues

Open **Work → GitHub Issues** on web/desktop, or **Settings → Work → GitHub Issues**
on mobile. Track an `owner/repository`, optionally choose a project for new imports,
and press **Sync**. GitHub access uses the GitHub CLI account on the selected
environment. If prompted, run `gh auth login` on that machine. GitHub Enterprise
repositories can use their own host.

Browse open issues, filter by repository, exact label or assignee username, and choose
**Import to Work Queue**. To import an issue directly, select its repository and enter
its issue number. Repeated imports reuse the same work item. Refresh details to read
the description, milestone and comments, or open the original issue on GitHub.

GitHub state and Work status are independent. Syncing a closed or reopened issue never
moves its work item. Untouched titles and descriptions follow GitHub changes; local
edits are preserved. Active and archived work retains its content. Comments always
belong to the GitHub snapshot.

To import matching issues during sync, configure one or more comma-separated labels.
An open issue matching any selected label enters Inbox. These rules never start agents.
Sync is manual; reloading the saved list does not contact GitHub.

Untracking clears the repository's saved issue data and keeps imported work. Re-track
and sync to restore the issue view. If access is lost or GitHub is rate limited, the
last saved data remains available and the sync error explains how to retry. Missing or
inaccessible imported issues are marked unavailable without deleting their tasks; other
issues can still refresh. A partial sync identifies these gaps. Retry after restoring access.
Trusted execution will not start from an unavailable issue or a failed repository sync. Large
responses are bounded; a sync that exceeds a limit reports an error rather than
silently marking incomplete data as current.

## Create and review a pull request

After execution passes validation and reaches **Review**, open **Plan / Execution** and
choose **Create Pull Request**. Review and edit the suggested title and body. The draft
includes the work summary, changed files, validation results, WorkItem ID and issue links.
Issue links do not close issues automatically. Add closing syntax yourself only when you
intend the PR to close that issue.

Inspect **View Changes** before submitting. **Commit, Push & Create PR** commits all current
changes in the execution worktree using the reviewed title as the commit message, pushes
its branch and uses the repository's normal PR target. Existing open PRs on that branch
are linked instead of duplicated; their existing title and body are preserved.

The PR number and URL remain attached to the WorkItem, which stays in Review. The panel
shows status, checks, reviewers, comments, review decision and mergeability. **Open PR**
opens GitHub; **Refresh PR** requests current data. Available merge methods follow the
host's permissions and require confirmation. GitHub still enforces its branch rules.

Failed creation retains the draft and an error. Retry after inspecting the branch; creation
never repeats automatically after a server restart. WorkItem edits while the draft is open
require reopening the draft before submission. The saved PR link remains available if GitHub
cannot be reached. Clients on older environments hide these controls until the server updates.

For subsequent changes, follow [Address PR review feedback](agent-orchestration.md#address-pr-review-feedback).
A confirmed merge completes linked work; closing an issue alone does not.
