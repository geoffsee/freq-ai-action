# Setup

This guide walks through configuring the caretta GitHub Action in a repository.

## 1. Repository prerequisites

- A Linux or macOS runner. The caretta release binary does not support Windows.
- An agent CLI installed on the runner before the action runs (the action does not install one for you). Choose one of:
  - `@anthropic-ai/claude-code`
  - `@openai/codex`
  - or any other agent supported via the `agent` input
- The matching API key stored as a repository or organization secret (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

## 2. Add secrets

In **Settings → Secrets and variables → Actions**, add the API key your chosen agent needs:

| Agent | Required secret |
| --- | --- |
| `claude` | `ANTHROPIC_API_KEY` |
| `codex` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `grok` / `xai` | `XAI_API_KEY` |

The default `${{ github.token }}` is passed through as `GH_TOKEN` for `gh` calls, so no extra GitHub token is needed in most cases.

## 3. Bot identity for `code-review` (GitHub App)

The `code-review` and `security-review` tasks post review verdicts via `gh api`. GitHub forbids approving your own PRs, so the default `${{ github.token }}` cannot approve PRs opened by the same workflow — you must provide a **separate bot identity**. Without one, the `code-review` task will fail or skip approvals.

> **Important:** `code-review` requires **two distinct identities** working together — the workflow's own `${{ github.token }}` (or whatever opened the PR) *and* a separate bot identity (Option A or B below) to post the review. GitHub will not let the same account that authored a PR approve it, so if you only configure one identity, code reviews are not possible. The agent API key (e.g. `ANTHROPIC_API_KEY`) does **not** count toward this — it authenticates the LLM, not GitHub.

Pick **one** of the two options below for the second identity.

### Option A — GitHub App (recommended)

1. **Create a private GitHub App** under your user or org **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - **Repository permissions**: Contents (read), Pull requests (read & write), Issues (read & write), Metadata (read).
   - No webhook URL or events required. No user-facing callback URL.
2. **Install the app** on the target repository (or whole org).
3. From the app's settings page, note:
   - **App ID** (top of the General tab).
   - **Installation ID** (the numeric id at the end of `https://github.com/settings/installations/<id>` after install).
4. **Generate a private key** (PEM) under the app's General tab and download it.
5. **Base64-encode the PEM** and store it as a secret — the action decodes `DEV_BOT_PRIVATE_KEY_B64` into a temp file and points `DEV_BOT_PRIVATE_KEY` at it for you:
   ```sh
   base64 -i path/to/app.private-key.pem | pbcopy   # macOS
   # or: base64 -w0 path/to/app.private-key.pem      # Linux
   ```
6. **Add three repository secrets** under **Settings → Secrets and variables → Actions**:

   | Secret | Value |
   | --- | --- |
   | `DEV_BOT_APP_ID` | The App ID from step 3 |
   | `DEV_BOT_INSTALLATION_ID` | The Installation ID from step 3 |
   | `DEV_BOT_PRIVATE_KEY_B64` | Base64-encoded PEM from step 5 |

7. **Pass them as `env:` on the action step** so caretta can mint an installation token at runtime:
   ```yaml
   - uses: geoffsee/caretta-action@v0.11.1
     with:
       task: code-review
       agent: claude
     env:
       ANTHROPIC_API_KEY:        ${{ secrets.ANTHROPIC_API_KEY }}
       DEV_BOT_APP_ID:           ${{ secrets.DEV_BOT_APP_ID }}
       DEV_BOT_INSTALLATION_ID:  ${{ secrets.DEV_BOT_INSTALLATION_ID }}
       DEV_BOT_PRIVATE_KEY_B64:  ${{ secrets.DEV_BOT_PRIVATE_KEY_B64 }}
   ```

caretta mints short-lived installation tokens on demand (cached ~50 minutes) and injects them as `GH_TOKEN` into the review subprocess. Reviews appear from the app's bot identity (e.g. `my-app[bot]`).

### Option B — Personal access token (second user)

1. Create a second GitHub user (e.g. `<owner>-bot`) and grant it write access to the repository.
2. From that user, generate a **fine-grained PAT** with Pull requests (read & write) and Issues (read & write) on the target repo.
3. Store it as a secret named `DEV_BOT_TOKEN` and pass it through:
   ```yaml
   env:
     DEV_BOT_TOKEN: ${{ secrets.DEV_BOT_TOKEN }}
   ```

### Environment variable reference

| Variable | Purpose | Required when |
| --- | --- | --- |
| `DEV_BOT_TOKEN` | Direct token (PAT or pre-minted installation token) | Using Option B |
| `DEV_BOT_TOKEN_PATH` | Path to a file containing the token | Alternative to `DEV_BOT_TOKEN` |
| `DEV_BOT_APP_ID` | GitHub App ID | Using Option A |
| `DEV_BOT_INSTALLATION_ID` | Installation ID for the app on this repo | Using Option A |
| `DEV_BOT_PRIVATE_KEY_B64` | Base64-encoded App PEM (decoded into a temp file by the action) | Using Option A |
| `DEV_BOT_PRIVATE_KEY` | Path to an already-on-disk PEM (set this **or** `_B64`, not both) | Using Option A |

Tasks that don't post reviews (`housekeeping`, `backlog-curation`, etc.) do not need any `DEV_BOT_*` variables.

## 4. Grant workflow permissions

Different tasks need different `permissions:` on the job. Start with the narrowest set and widen if the agent reports `gh` permission errors.

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

| Task family | Suggested permissions |
| --- | --- |
| `housekeeping`, `backlog-curation`, `refresh-docs`, `refresh-agents`, `fix-pr` | `contents: write`, `pull-requests: write`, often `issues: write` |
| `code-review`, `security-review` | `contents: read`, `pull-requests: write` |
| `issue`, `loop` | `contents: write`, `issues: write`, `pull-requests: write` |

If the action will push commits or open PRs, also enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**.

## 5. Add a workflow

Create `.github/workflows/caretta.yml`. The minimal setup checks out the repo, installs an agent CLI, and runs caretta:

```yaml
name: caretta

on:
  workflow_dispatch:
  schedule:
    - cron: "0 9 * * 1" # Mondays 09:00 UTC

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  housekeeping:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm install -g @anthropic-ai/claude-code

      - uses: geoffsee/caretta-action@v0.11.1
        with:
          task: housekeeping
          agent: claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Ready-made workflows for `housekeeping`, `code-review`, and `fix-pr` live in [`examples/`](../examples).

## 6. Pin the version

`version: latest` resolves the newest GitHub release at run time. For reproducible builds, pin to a specific tag:

```yaml
- uses: geoffsee/caretta-action@v0.11.1
  with:
    task: housekeeping
    version: v0.11.1
```

## 7. Verify

Trigger the workflow manually from the **Actions** tab. On success, the run logs include:

- `installed-version`: the caretta release tag that was downloaded.
- `exit-code`: caretta's exit status (0 on success).

If the run fails before invoking caretta, check that the agent CLI install step ran and that the API key secret is set.

## Troubleshooting

- **`agent CLI not found`** — the install step (e.g. `npm install -g @anthropic-ai/claude-code`) is missing or ran on the wrong runner OS.
- **`gh: permission denied`** — widen the job's `permissions:` block; see the table above.
- **`refusing to merge unrelated histories` / empty diffs** — set `fetch-depth: 0` on `actions/checkout` so caretta sees full history.
- **PRs not opening** — enable workflow PR creation under Settings → Actions → General.

## Local development

To iterate on the action itself:

```bash
bun install
bun run typecheck
bun run build   # bundles dist/index.js — must be committed
```

`action.yml` points at `dist/index.js`, so the bundled output is committed alongside the source.
