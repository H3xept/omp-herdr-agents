# Changelog

## Unreleased

- `message_parent` (child tool): a child sends a message to the parent conversation and keeps working. The message starts a parent turn when the parent is idle; the parent replies with `herdr_send`.
- Live progress: each `herdr_task` row shows the intent of the agent's latest tool call, its tool call count, tokens, cost, and turn time. Results report the same usage totals.
- Background results arrive per agent, as each one finishes, instead of once for the whole batch.
- Spawned agents persist in the parent session. After `--continue` or `--resume`, the parent restores them and delivers background results that were still pending.
- `herdr_agents`: `list` the spawned agents, read an agent's latest `output` or condensed `transcript`, `cancel` its current turn, or `close` its pane.
- Cancellation works in vim-mode omp: the plugin sends a second Esc only while the child still reports `working`.
- `placement: "pane"` batches tile instead of slicing the caller's pane into thin columns. Splits now run one at a time, so each one measures the pane after the previous split.

## 0.1.0

- `herdr_task`: spawn omp agents (`scout`, `task`, `reviewer`, custom agents) as interactive omp sessions in a new herdr workspace, tab, or pane, each in its own working directory. The final message of each agent is the tool result; blocking and background modes.
- `herdr_send`: send a follow-up to a spawned agent and return its reply. Turns that a human started in the child pane before the call are skipped; a follow-up to a working agent steers its current turn.
- Child reporter (`src/child.ts`) that writes each settled turn to the run directory.
