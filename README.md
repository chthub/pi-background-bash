# pi-background-bash

Async/background `bash` for [Pi](https://github.com/earendil-works/pi): keep using the normal `bash` tool, but long-running commands stop blocking the agent.

`pi-background-bash` replaces Pi's bash execution with the PBB runner and adds two quality-of-life features:

- `background: true` starts a command in the background immediately.
- normal foreground commands automatically move to the background after 30 seconds.

As of v1, PBB-owned execution is the baseline: jobs are recorded with logs plus `pid`/`pgid`, and full output is available through `pbb tail`.

When a background command finishes, the extension injects a follow-up result into the session and wakes the agent.

While jobs are running, a compact pending-job widget is shown below Pi's editor/input area. This fork keeps that widget implementation inline and does not depend on `pi-pending`.

## Why

AI coding agents often need to run slow commands: test suites, builds, dev servers, downloads, deploys, benchmark loops, and watchers. Without background execution, the agent gets stuck waiting. With this extension, the agent can continue useful work and handle the command output when it arrives.

## Install

Install from GitHub:

```bash
NPM_CONFIG_ALLOW_GIT=all pi install git:github.com/chthub/pi-background-bash
```

`NPM_CONFIG_ALLOW_GIT=all` is needed with npm 12+ because this package depends on `pi-lane` through a Git reference.

Try without installing:

```bash
NPM_CONFIG_ALLOW_GIT=all pi -e git:github.com/chthub/pi-background-bash
```

Local development:

```bash
git clone https://github.com/chthub/pi-background-bash.git
cd pi-background-bash
NPM_CONFIG_ALLOW_GIT=all npm install
npm test
pi -e .
```

## Usage

Run a command normally. If it is still running after 30 seconds, it automatically moves to the background:

```ts
bash({ command: "npm test" })
```

Start a command in the background immediately:

```ts
bash({ command: "npm test", background: true })
```

Add a timeout if you want Pi to kill the command after a fixed number of seconds:

```ts
bash({ command: "npm test", background: true, timeout: 120 })
```

Completion results arrive as Pi context messages:

```xml
<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001" outcome="exit" exit_code="0">
...
</pi_context>
```

Commands run through the PBB-owned bash runner (`bash -lc`) so background jobs have recorded `pid`/`pgid` and can be killed as process groups. Verbose completion messages are truncated in-session with a `pbb tail <job> --full` hint; the full output is kept in the PBB log. See [`docs/pbb-runner.md`](docs/pbb-runner.md) for the v1 runner contract.

## v1 migration

v1 is a hard migration to PBB-owned execution. The old native-runner compatibility path and `PI_BACKGROUND_BASH_RUNNER` switch are gone. If you depended on exact pre-v1 bash formatting, update callers to use `pbb tail <job> --full` for complete output and the recorded PBB job metadata for process control.

## `pbb` CLI

This package also installs `pbb`, a small inspector for background bash jobs.

```bash
pbb self
pbb list
pbb status bg001
pbb tail bg001 -n 80
pbb kill bg001
```

`pbb` is designed for agents: output is wrapped in compact `pi_context` envelopes and always includes session/instance identity. Local job IDs are fixed-width strings such as `bg001`, `bg002`, and `bg010` so listings sort chronologically. `pbb` uses [`pi-lane`](https://github.com/sshkeda/pi-lane) runtime identity env vars (`PI_LANE_SESSION_KEY`, `PI_LANE_INSTANCE_ID`, etc.) and defaults to the current live Pi instance, not every terminal attached to the same session.

Background job state is stored under:

```text
~/.pi/pbb/sessions/{sessionKey}/instances/{instanceId}/
  identity.json
  jobs/{jobId}.json
  events.jsonl
  logs/{jobId}.log
```

`pbb list` and `pbb status` show owner liveness through the tracked `pil` CLI from `pi-lane`, so stale/disconnected owners are visible instead of silently confused with the current runtime. If tracked `pi-lane`/`pil` is missing or fails, `pbb` hard-fails instead of silently degrading liveness to unknown.

`pbb kill` writes a kill request into the owning instance mailbox. A live `pi-background-bash` runtime polls that mailbox and aborts the matching in-process job. Jobs record `pid`/`pgid`, so the runtime kills the full process group. If the owner is stale, `pbb kill --stale --instance <id> <job>` can signal the recorded process group explicitly.

## Configuration

Default auto-background threshold: `30` seconds.

Configure the global threshold in `~/.pi-background-bash/config.json`:

```json
{
  "autoBackgroundAfterSeconds": 10
}
```

Disable automatic backgrounding while keeping `background: true` available:

```json
{
  "autoBackgroundAfterSeconds": 0
}
```

You can also override the threshold for a single project with `.pi/background-bash.json` in that project. Project config wins over global config.

## Agent prompt behavior

The extension updates the `bash` tool metadata exposed to models:

- the `background` boolean is part of the tool schema
- the tool description documents automatic backgrounding
- prompt snippets/guidelines teach the agent not to retry just to wait
- prompt guidelines teach the agent to use `pbb list/status/tail` for inspection
- background completion messages are described as final bash results

No global Pi prompt patch is required.

## Fork notes

This fork inlines the small context-formatting/truncation helpers that upstream imported from `pi-context`, and inlines the pending-job widget that upstream imported from `pi-pending`.

`pi-lane` is intentionally kept as the only runtime package dependency. `pbb` uses it for multi-instance Pi identity and owner liveness, so commands such as `pbb list`, `pbb status`, and `pbb kill` can distinguish jobs owned by the current live Pi instance from jobs owned by other or stale instances.

## Security

This is a Pi extension. Like any Pi package, it runs with your local user permissions and can execute shell commands requested by the agent. Review the source before installing third-party extensions.

## Development

```bash
npm install
npm run hooks:install
npm run typecheck
npm test
```

This repo uses Lefthook for local pre-commit checks. The test suite uses [`pi-mock`](https://github.com/sshkeda/pi-mock) to exercise the extension against a real Pi process.

## License

MIT
