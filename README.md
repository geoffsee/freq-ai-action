# freq-ai GitHub Action

Run [freq-ai](https://github.com/geoffsee/freq-ai) automated maintenance tasks against a repository directly from GitHub Actions.

The action downloads the freq-ai release binary onto the runner, optionally configures a `github-actions[bot]` git identity, then invokes a freq-ai subcommand against the checked-out repo.

## Prerequisites

- A linux or macOS runner (Windows is not supported by the freq-ai release binary).
- The agent CLI you want freq-ai to drive (e.g. `@anthropic-ai/claude-code`, `@openai/codex`) must be installed and authenticated on the runner *before* the action runs. The action does not install agent CLIs for you, so you stay in control of versions and credentials.
- The corresponding agent API key as a workflow secret (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), passed via `env:`.

## Usage

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

- uses: actions/setup-node@v4
  with:
    node-version: "20"

- run: npm install -g @anthropic-ai/claude-code

- uses: geoffsee/freq-ai-action@v0.0.1
  with:
    task: housekeeping
    agent: claude
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

See [`examples/`](./examples) for ready-made workflows: weekly housekeeping, code review on pull requests, and on-demand `fix-pr`.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `task` | yes | — | freq-ai subcommand to run. One of: `housekeeping`, `refresh-docs`, `refresh-agents`, `code-review`, `security-review`, `ideation`, `sprint-planning`, `retrospective`, `strategic-review`, `roadmapper`, `uxr-synth`, `interview`, `fix-pr`, `issue`, `loop`. |
| `args` | no | `""` | Positional arguments for tasks that need them. Required for `fix-pr` (PR number), `issue` (issue number), and `loop` (tracker id). |
| `agent` | no | `claude` | Which agent CLI to drive: `claude`, `cline`, `codex`, `copilot`, `gemini`, `grok`, `junie`, `xai`, `cursor`. |
| `version` | no | `latest` | freq-ai release tag. `latest` resolves the most recent GitHub release. |
| `auto` | no | `true` | Pass `--auto` to freq-ai (skip interactive prompts). |
| `dry-run` | no | `false` | Pass `--dry-run` to freq-ai. |
| `working-directory` | no | `$GITHUB_WORKSPACE` | Directory to run freq-ai in. |
| `configure-git` | no | `true` | Configure git identity as `github-actions[bot]` before running. Set `false` if you set the identity yourself. |
| `github-token` | no | `${{ github.token }}` | Token exposed to freq-ai as `GH_TOKEN` for `gh` calls. |

## Outputs

| Output | Description |
| --- | --- |
| `installed-version` | Resolved freq-ai release tag that was installed. |
| `exit-code` | Exit code returned by freq-ai. |

## Permissions

Different tasks need different `permissions:` blocks on the calling job. Common patterns:

- `housekeeping`, `refresh-docs`, `refresh-agents`, `fix-pr` — `contents: write`, `pull-requests: write`, often `issues: write`.
- `code-review`, `security-review` — `contents: read`, `pull-requests: write`.
- `issue`, `loop` — `contents: write`, `issues: write`, `pull-requests: write`.

When in doubt, start narrow and add scopes as the agent reports `gh` permission errors.

## Development

```bash
bun install
bun run typecheck
bun run build   # bundles dist/index.js — must be committed
```

`action.yml` points at `dist/index.js`, so the bundled output is committed alongside the source. Re-run `bun run build` after every change to `src/`.
