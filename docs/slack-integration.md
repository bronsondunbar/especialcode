# Slack integration

Open **Work → Slack** on web, desktop or mobile and connect your workspace. Direct
mentions of your connected account become Work tasks automatically, without channel
selection or automation rules. The initial sync covers the last seven days. Sync continues
every five minutes while the environment runs, including when clients are closed, and
catches up from the last successful sync after downtime.

Tasks start in **Inbox**, retain the source message and thread link, and do not start agents
just because the workspace is connected. Repeated mentions sync into the same task. Local
edits, task status and archived work are preserved. Ignored messages are not imported.
Search covers conversations accessible to the connected account, including private
conversations and thread replies. Everyone with read access to the environment can see
the resulting tasks and their source context. Slack search visibility, retention and search
filters can limit results; see [Slack search behavior](https://docs.slack.dev/reference/methods/search.messages/).

The workspace shows the last sync and any failure. Failed batches retain the last successful
cursor and retry automatically. Other connected workspaces continue syncing. Disconnecting
stops automatic imports and preserves existing Work tasks.

## Optional channel defaults and manual imports

Configure a channel only if you want default project/repository values for its new tasks,
or want to browse other messages manually. **Sync mentions** reads that channel from the
last seven days. Enable channel mentions to include `@channel`, `@here` and `@everyone`
in the manual inbox; these broad mentions do not automatically create tasks. **Older results**
continues through that window.
Paste a Slack message link to add a specific message from a configured channel, including
older messages. Choose the link's workspace first. **Refresh thread** loads context, and
**More replies** extends the bounded preview. Open Slack for very long threads.

Choose **Create Task**, or **Ask Agent** to create a task and open planning. New tasks use
the project, repository and priority shown in the channel/task defaults form, falling back
to that message's channel settings when blank. Review those values before importing.
The task retains the workspace, channel, message and thread references. Importing the same
message again opens its existing task. **Attach to existing task** adds the source reference
to a task you choose without replacing its content. Search by title to find older tasks.
**Ignore** hides a message; use the ignored view and **Restore** to bring it back.

Stopping channel tracking clears its manual inbox cache and defaults; direct mentions still
create tasks while the workspace is connected. Disconnecting a workspace removes its
local credentials and cached channels/messages and attempts to revoke Slack access.
Imported tasks and their source references remain. Slack mentions and imports follow the
Slack categories in Notification preferences. No action sends a message to Slack.

### Connect your Slack app

The environment owner needs a Slack app and a stable HTTPS address that reaches the
T3 server, including from the browser used to authorize it. In Slack's **OAuth & Permissions**,
register that address followed by `/api/integrations/slack/callback` as the redirect URL.
Enable the user-token scopes `search:read`, `channels:read`, `groups:read`,
`channels:history` and `groups:history`. No bot or message-writing scopes are needed.
Set these environment variables on the machine running the T3 server, then restart it:

```text
T3CODE_SLACK_CLIENT_ID=<Slack app client ID>
T3CODE_SLACK_CLIENT_SECRET=<Slack app client secret>
T3CODE_SLACK_REDIRECT_URI=https://your-server.example/api/integrations/slack/callback
```

Keep the secret out of source control and client configuration. Select **Connect workspace**
and follow **Continue to Slack**. Authorization links expire after ten minutes. Tokens
stay in the server's protected secret store; expiring tokens refresh automatically when
Slack token rotation is enabled. Reconnect if Slack revokes access or permissions change.
Slack requires an HTTPS redirect; an HTTP-only local server needs an HTTPS endpoint routed
to it before connecting. See [Slack's OAuth setup](https://docs.slack.dev/authentication/installing-with-oauth/)
and [token rotation](https://docs.slack.dev/authentication/using-token-rotation/).

Slack may limit requests, especially thread reads for commercially distributed apps outside
its Marketplace. The inbox reports a cooldown and keeps previously loaded messages; retry
after the indicated delay. Channel and message status show the last successful refresh and
any error. Unavailable messages keep their cached content and imported tasks; reconnect or
restore access, then refresh again. Repeating a sync or import does not duplicate notifications
or tasks. See [Slack's rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

For approval and execution, continue with [Agent orchestration](agent-orchestration.md).
