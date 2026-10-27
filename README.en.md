# SOXU Agent Loop

Development orchestration and a local monitoring dashboard for [SOXU](https://github.com/TanCan1998/SOXU). This migration preview has not passed a complete release validation. It requires Node.js 24+, Git, GitHub CLI, Pi, and the target project's own toolchain and model authentication.

Set `SOXU_PROJECT_ROOT` to the absolute project path before running `node automation/loop/src/cli.mjs doctor`, `node automation/loop/src/cli.mjs status --local`, or `node automation/loop/src/dashboard-cli.mjs`. Git and GitHub operations use the target project. The dashboard listens on localhost and creates a session token. Worktrees remain owned by the target repository.

Data defaults to the target project's `.soxu` directory. To copy supported checkpoints, reports, drafts and model settings to a new directory, stop **all** old and new dashboards, runners and agents first, inspect existing locks, and run:

```powershell
node automation/loop/src/migrate-data.mjs 'F:\workplace\pi\SOXU' 'F:\workplace\pi\soxu-loop-data' --offline
$env:SOXU_PROJECT_ROOT = 'F:\workplace\pi\SOXU'
$env:SOXU_DATA_DIR = 'F:\workplace\pi\soxu-loop-data'
node automation/loop/src/cli.mjs resume --local --dry-run
```

The target must not exist. The command verifies copies and preserves old data. Locks remain under the target project to be shared with legacy runners. Old runners cannot enforce the migration boundary: do not start them after switching, or state may diverge. To revert, stop processes and reconcile both data directories first. The `--offline` flag requires the operator to ensure all processes are stopped.

Run `npm test` with `SOXU_PROJECT_ROOT` pointing to a SOXU checkout; tests include target-project integration contracts. Never commit model credentials or local runtime data. Dashboard hot updates are not yet implemented.
