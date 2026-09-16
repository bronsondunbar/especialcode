# Notifications

Open **Notifications** from the sidebar or command palette. On mobile, use the bell
in the thread list or **Settings → Notifications**. Choose an environment to see its inbox;
notifications and read state are shared with other clients connected to that environment.

The inbox highlights plans ready for approval, requests for agent input, completed work,
PR reviews, failed checks and execution failures. Filters help you focus on agents,
GitHub, or items needing attention. Routine edits and execution starts do not add inbox noise.
Use a notification's action to open the agent, review changes, or inspect PR feedback and
send it to the agent. Sending feedback still requires reviewing the existing confirmation.

Mark individual notifications read or unread, or mark all currently received notifications
read. Read state survives reconnects and server restarts. The inbox begins collecting when
the environment updates; it does not import old notification history.

On web and desktop, open **Settings → General → Behavior → Notification preferences**
to choose agent, GitHub and Slack categories and enable in-app or desktop delivery.
These choices apply to future events across the
environment; disabling a category keeps existing inbox history. **Restore defaults** resets
the environment's preferences. Slack options become active when Slack integration is available.

On web or desktop, **Thread notifications** in the same Settings section enables native
alerts and optional sound on this device.
Browsers request notification permission; system settings and Focus/Do Not Disturb can
suppress delivery. Desktop alerts prioritize input, completion, failures and PR review
activity. Clicking an alert restores the desktop window and opens the matching WorkItem,
agent or changes view. Foreground toasts retain the device's existing in-app alert setting.

Native delivery requires a connected client. Initial connection does not replay inbox
history; reconnect delivers only unread alerts received within the last two minutes.
Closing the client stops native delivery, while the environment continues recording its
inbox. Mobile push and Live Activities keep their existing settings.

No additional environment variables are required for the Work notification inbox or native
web/desktop alerts. Delivery preferences are environment-wide; permission, sound and native
alert availability also depend on the receiving device. These alerts do not add a new
background mobile push service. For automation-generated alerts, see [Automations](automation.md).
