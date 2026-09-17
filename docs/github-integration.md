# GitHub integration

## Turn assigned issues into Work tasks

Open **Work → GitHub** (on mobile: **Settings → Work → GitHub**) and
choose **Connect GitHub account** with a personal access token. Connection management
requires administrator access to the selected environment. For private repositories across
organizations, create a classic token with `repo` scope and authorize each organization’s
SSO when required ([GitHub token guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). Organization policies and the token’s repository access determine which
issues GitHub makes visible; organization membership alone does not grant token access.
Add `read:org` for team reviewer information. PR details and individual reviewers load without it.

Open issues assigned to your account become Work tasks immediately, then sync every five
minutes while the environment is running. Newly accessible repositories are discovered
automatically. No automation rules are required. Tasks start in **Inbox** with their description and original GitHub link;
you do not need to track repositories or import issues individually. Pull requests are excluded.
Repeated syncs reuse the same task. Local edits and Work status are preserved, and agents
are not started automatically. Issues no longer assigned to you, closed issues, and existing
tasks remain in Work; assignment sync does not archive or complete them.

**Sync assigned issues** refreshes immediately. **Update token** renews credentials for the
same account. **Disconnect account** removes the token and stops automatic imports, keeping
existing tasks. Disconnect before switching accounts. Tokens are stored on the selected
environment, never returned to clients. Tasks are shared with clients that can access that
environment. Assigned-issue sync does not require the GitHub CLI. The same connected
account is used by the **PRs** tab and **Create PR** in a thread for GitHub.com.

GitHub documents the scope of [assigned-issue discovery](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

## Configure Git and pull request access

Install the GitHub CLI on the machine running the selected T3 environment. With an account
connected in **Work → GitHub**, PR browsing, reviews and creation use that token; a separate
`gh auth login` is not required for GitHub.com. The token needs access to the repository and
permission for the PR actions you use. Updating the token takes effect on subsequent requests.

For GitHub Enterprise, authenticate the selected host with `gh auth login --hostname HOST`.
The account needs access to the repository. PR publication additionally needs the
normal Git push and GitHub PR permissions. Authentication on a client laptop does not grant
access to a remote environment. This integration adds no required GitHub environment variable;
The app does not change the CLI’s saved login or Git credentials. Git fetch/push still use
your repository’s transport credentials. GitHub.com PR operations require the connected Work
account; disconnecting it stops PR access until you reconnect, even if the CLI has another
saved login. Keep credentials on the server.

## Create and review a pull request

The **PRs** feed shows pull requests you authored, pull requests assigned to you, and pull
requests asking for your review, using your connected GitHub account. Search and filters
narrow this personal feed across all repositories the token can access, including repositories
you have not added or cloned locally. Selecting a project narrows the feed to that repository.
Other contributors’ unrelated PRs are excluded.

After execution passes validation, open **Plan / Execution** and
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

To act on unresolved review discussions, open a PR and choose **Address comments**. Select an
active linked thread or **New thread on PR branch**, then review and send the prepared prompt.
A new thread needs the repository added as a project on the selected server and uses a worktree
on the PR branch. Resolved discussions are excluded; replies and file locations travel with
the remaining comments. This does not post replies or mark discussions resolved on GitHub.

For subsequent changes, follow [Address PR review feedback](agent-orchestration.md#address-pr-review-feedback).
A confirmed merge completes linked work; closing an issue alone does not.

## Post issue updates

From a task-linked thread, choose **Draft update**, select the issue, and review or edit the
latest agent response before choosing **Post GitHub comment**. A fine-grained token needs
[Issues write permission](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
on the target repository. The configured GitHub CLI account is used when no account token is saved.
