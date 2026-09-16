# GitHub integration

## Turn assigned issues into Work tasks

Open **Work → GitHub** (on mobile: **Settings → Work → GitHub**) and
choose **Connect GitHub account** with a personal access token. Connection management
requires administrator access to the selected environment. For private repositories across
organizations, create a classic token with `repo` scope and authorize each organization’s
SSO when required ([GitHub token guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). Organization policies and the token’s repository access determine which
issues GitHub makes visible; organization membership alone does not grant token access.

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
environment. This connection does not require the GitHub CLI or change Git/PR credentials.

GitHub documents the scope of [assigned-issue discovery](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user).

## Configure Git and pull request access

Install and authenticate the GitHub CLI on the machine running the selected T3 environment:

```sh
gh auth login
gh auth status
```

For GitHub Enterprise, authenticate the selected host with `gh auth login --hostname HOST`.
The account needs access to the repository. PR publication additionally needs the
normal Git push and GitHub PR permissions. Authentication on a client laptop does not grant
access to a remote environment. This integration adds no required GitHub environment variable;
Git and pull request operations reuse T3's GitHub CLI configuration. Keep credentials on the server.

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
