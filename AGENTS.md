# Project instructions

Preserve existing user changes and local configuration. Read the applicable `AGENTS.md` inside a component before editing it. Keep source implementation, local validation, packaging, deployment and production commissioning distinct; never include credentials in logs or handoff records.

## DSH upstream integration handoff

For the `dsh-upstream-integration` requirement, read `.agent-handoff/tasks/dsh-upstream-integration/HANDOFF.md` and its `state.json` when present, then verify the current branch, HEAD and relevant files. These local records are background, not additional deployment authorization. If they are absent, use `dsh-aigc/README.md` and inspect the actual repository state.

Use the `workbuddy-handoff` skill to update the same task after verified steps, failures, scope changes and before ending an unfinished turn. Record the exact next action, validation evidence, running processes and remaining limitations. Do not mark the 0.2.x migration complete merely because the upgrade tooling is implemented. Do not overwrite generated handoff Markdown directly.
