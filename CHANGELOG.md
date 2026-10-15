# Changelog

## Unreleased

- `placement: "pane"` batches tile instead of slicing the caller's pane into thin columns. Splits now run one at a time, so each one measures the pane after the previous split.

## 0.1.0

- `herdr_task`: spawn omp agents (`scout`, `task`, `reviewer`, custom agents) as interactive omp sessions in a new herdr workspace, tab, or pane, each in its own working directory. The final message of each agent is the tool result; blocking and background modes.
- `herdr_send`: send a follow-up to a spawned agent and return its reply. Turns that a human started in the child pane before the call are skipped; a follow-up to a working agent steers its current turn.
- Child reporter (`src/child.ts`) that writes each settled turn to the run directory.
