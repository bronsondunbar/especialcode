# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## Project-management fork

This checkout adds a Work queue and developer dashboard across web, desktop and mobile:

- Organize tasks and import GitHub issues or Slack messages without losing their source context.
- Generate structured plans, review and approve them, then execute in dedicated worktrees.
- Create PRs, send review feedback back to the existing agent thread, and track validation and merges.
- Follow work through a durable notification inbox and explicitly configured automation rules.

Work runs inside the existing environment server and SQLite database. Typed RPCs connect all
clients; provider execution, checkpoints, Git workflows and PR operations use T3's existing
services. The [project-management guide](./docs/project-management.md) covers the data model,
lifecycles and known limits; [architecture boundaries](./docs/project-management-architecture.md)
explain the separation from the underlying agent runtime.

### Run this fork locally

The published upstream package and releases below may not contain these additions. To run
this checkout, use Node matching `package.json` (`^24.13.1`), [install Vite+](#install-vp), then:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the runner, configure a project/provider, and open **Work**.
Use `vp run dev:desktop` for Electron; see the [mobile README](./apps/mobile/README.md) for native
development. The [development runbook](./docs/operations/development.md) explains isolated state
and remote pairing. Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset in development.

### Configure Work

GitHub uses the environment machine's existing GitHub CLI account. Run `gh auth login` there,
then track repositories under **Work → GitHub Issues**. See [GitHub setup](./docs/github-integration.md).

For Slack, register an HTTPS OAuth callback and set these variables on the server before
restarting it. Values below are placeholders:

```dotenv
T3CODE_SLACK_CLIENT_ID=<app-client-id>
T3CODE_SLACK_CLIENT_SECRET=<app-client-secret>
T3CODE_SLACK_REDIRECT_URI=https://your-server.example/api/integrations/slack/callback
```

Then connect the workspace and select shared channels. Keep credentials out of source control
and client configuration. [Slack setup](./docs/slack-integration.md#connect-your-slack-app) lists
the required read scopes and explains which account content becomes visible to the environment.

Configure inbox categories and delivery in **Notifications → Notification preferences**, then
enable native alerts on each device. [Notifications](./docs/notifications.md) explains reconnect
and mobile delivery limits. No extra environment variables are needed for Work notifications.

### Automation safety

Rules start disabled. Automatic execution requires explicit rule trust, a current approved
plan, repository/label/provider allowlists and concurrency limits. Provider approvals remain
active; validation is required by default. Validation and project setup commands execute on
the environment host, so review them before trusting a rule. Rules cannot approve plans or
merge PRs. **Stop all automations** persists a pause and requests stops for automation-owned
work; resume handles future events. See [Automations](./docs/automation.md).

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Project management and local setup](./docs/project-management.md)
- [Work items and activity](./docs/work-items.md)
- [Planning, execution and review cycles](./docs/agent-orchestration.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
