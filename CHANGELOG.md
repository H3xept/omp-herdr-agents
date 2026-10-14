# Changelog

## 0.1.0

- `herdr_task`: spawn omp agents (`scout`, `task`, `reviewer`, custom agents) as interactive omp sessions in a new herdr workspace, tab, or pane, each in its own working directory. The final message of each agent is the tool result; blocking and background modes.
- `herdr_send`: send a follow-up to a spawned agent and return its next final message.
- Child reporter (`src/child.ts`) that writes each settled turn to the run directory.
