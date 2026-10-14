# omp-herdr

An [omp](https://omp.sh) plugin that spawns omp subagents as interactive omp sessions in [herdr](https://herdr.dev). Each agent runs in its own working directory and gets its own herdr workspace, tab, or pane.

The built-in `task` tool runs subagents inside the parent process, in the parent's working directory. You cannot watch them or talk to them. `omp-herdr` adds two tools with the same contract as `task`:

- `herdr_task` spawns agents (`scout`, `task`, `reviewer`, or your own agent definitions) in any directory. The final message of each agent is the tool result.
- `herdr_send` sends a follow-up to an agent that `herdr_task` spawned. The agent keeps its context.

The agents stay open in herdr after they finish, so you can read their work, type to them, or resume them.

## Requirements

- omp 18.10.4 or later.
- herdr 0.9 or later, with the omp running **inside a herdr pane** (`HERDR_ENV=1`). Outside herdr the plugin registers no tools.
- `omp` on the `PATH` of the herdr server, because herdr starts the child agents.
- Optional: the herdr omp integration (`herdr integration install omp`) gives herdr exact `working`/`idle`/`blocked` states for omp panes.

## Install

```sh
omp plugin install github:<owner>/omp-herdr
# or, from a local checkout:
git clone https://github.com/<owner>/omp-herdr && omp plugin link ./omp-herdr
```

To try it for one session without installing:

```sh
omp -e /path/to/omp-herdr/src/index.ts
```

## Usage

Ask omp for it in plain language, for example: "Use herdr_task to have a scout map the auth flow in ~/code/api". The model calls the tool like this:

```json
{
  "context": "We are adding SSO to the api service.",
  "tasks": [
    { "agent": "scout", "cwd": "~/code/api", "task": "Map the auth flow; list files and entry points." },
    { "agent": "task", "cwd": "../web", "name": "web-login", "placement": "tab", "task": "Add an SSO button to the login page." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `tasks[].cwd` | Working directory of the agent: absolute, `~/…`, or relative to the caller's directory. Required. |
| `tasks[].agent` | Agent type, as for `task`. Default: `task`. |
| `tasks[].task` | The complete, self-contained assignment. |
| `tasks[].name` | herdr agent name. herdr lowercases it and adds `-2`, `-3`, … when the name is in use. Default: the agent type. |
| `tasks[].placement` | `workspace` (default): a new herdr workspace. `tab`: a new tab in `workspace`, else in a workspace that already has a pane at `cwd`, else in the caller's workspace. `pane`: a split next to the caller's pane. |
| `tasks[].workspace` | herdr workspace id for `placement: "tab"`. |
| `context` | Shared background for every agent in the call. |
| `background` | `true`: the tool returns at once and the results arrive later as one message. Default: the omp `async.enabled` setting. |

`herdr_send` takes `name`, `message`, and `background`. It accepts only agents that `herdr_task` spawned in the same omp session.

## How it works

```mermaid
sequenceDiagram
    participant P as Parent omp (herdr_task)
    participant H as herdr
    participant C as Child omp (in new pane)
    P->>P: resolve agent definition, model, tools
    P->>H: workspace create / tab create / pane split (--cwd, --env OMP_HERDR_RUN_DIR)
    P->>H: agent start --kind omp -- -e child.ts --append-system-prompt ...
    H->>C: start omp in the pane
    P->>H: agent prompt (assignment)
    C->>C: work (visible in herdr)
    C->>P: child.ts writes result.json on agent_end
    P->>P: return the final message as the tool result
```

1. The parent resolves the agent type through omp's own agent discovery, so project, user, plugin, and bundled agents all work. The model follows `task.agentModelOverrides` and the agent's `model` patterns, then the parent's current model. Agent `tools` that the session does not know are dropped.
2. The parent writes the agent's role prompt, the shared context, and a completion contract to a run directory under the system temp directory. The child loads that file with `--append-system-prompt`.
3. herdr creates the pane in the target directory and starts `omp` there with `herdr agent start --kind omp`.
4. The parent submits the assignment with `herdr agent prompt`.
5. `src/child.ts`, loaded into the child with `-e`, writes `result.json` to the run directory each time the child's main agent finishes a turn. It waits while the child's own background jobs run.
6. The parent polls `result.json` and checks the agent with `herdr agent get`. It reports `completed`, `failed`, `aborted`, or `lost` (the agent left its pane before it reported).

## Behavior notes

- **Approvals.** Child agents run with `--approval-mode yolo`, like headless `task` subagents. Set `OMP_HERDR_APPROVAL_MODE` (for example `write` or `always-ask`) in the parent's environment to change this. A child that waits for approval keeps the parent waiting.
- **Human input.** A message that you type into a child pane also ends a turn. While the parent waits, that turn's final message becomes the result.
- **Structured output.** For agents with an `output` schema (such as `scout`), the child is told to answer with one JSON object that matches the schema. Nothing validates it.
- **Cancellation.** When the parent aborts a blocking call, the plugin sends `Esc` to each child and stops waiting. The panes stay open.
- **Cleanup.** The plugin never closes panes or workspaces. Close them in herdr when you are done. Run directories stay in the system temp directory.
- **`wait` tool.** omp's `wait` tool tracks omp jobs only. Background results from this plugin arrive as a message without it.
- **Large output.** Results longer than 30,000 characters are cut in the tool result. The full text stays in the run directory's `result.json`.

## Develop

```sh
bun install
bun run check   # tsc
bun test
```

`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/omptype` are dev dependencies for types and tests only. At runtime the omp extension loader resolves `@oh-my-pi/*` imports to the running omp.

## License

MIT
