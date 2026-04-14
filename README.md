# claude-lobster-mcp

An MCP server that translates standard [Lobster](https://github.com/openclaw/lobster) workflow files into Claude Code actions — enabling deterministic orchestration for AI agent team sessions.

The same `.lobster` workflow file runs natively in OpenClaw via the Lobster runtime, or in Claude Code via this driver.

## The Problem

Prompt engineering can't reliably enforce deterministic workflows in AI agent team sessions. LLMs ignore tool names, skip steps, and reorder operations. The creative work within each step is fine — the orchestration is what fails.

This driver moves orchestration out of the prompt and into a typed workflow file. The LLM handles generative work. The driver handles sequencing.

## How It Works

The MCP server is an **interpretive layer** (a "driver") that reads Lobster workflow files and translates each step into a concrete Claude Code instruction.

```
.lobster file ─→ Parse ─→ Detect Mode ─→ Translate ─→ Agent Executes
                  │            │              │
                  │            ├─ Teams mode   ├─ "Call TeamCreate..."
                  │            └─ Agent mode   └─ "Call Agent tool..."
                  │
              Pure Lobster YAML
              (no custom extensions)
```

### Environment Detection

At load time, the driver checks:
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var
- `TMUX` env var (running inside tmux)

Both present → **Teams mode** (TeamCreate, tmux panes, shared task list).
Otherwise → **Agent fallback** (background Agent tool calls).

### Translation Rules

| Lobster Pattern | Teams Mode | Agent Fallback |
|---|---|---|
| `llm.invoke --model opus` | Spawn/message Opus teammate | Opus Agent call |
| `parallel:` branches | TeamCreate per branch (tmux panes) | Parallel Agent calls |
| `llm.invoke` (no --model) | Instruction to lead agent | Instruction to lead agent |
| `approval:` | Gate — blocked until approved | Gate — blocked until approved |
| `run:` / `command:` | Shell execution | Shell execution |

The driver tracks spawned teammates — the first `--model opus` call spawns a teammate, subsequent calls message the existing one.

## Quick Start

### Install

```bash
npm install
npm run build
```

### Register with Claude Code

Use `claude mcp add` to register the server. All options must come before the server name, and `--` separates the name from the command.

```bash
# Add for the current project only (default local scope)
claude mcp add --transport stdio claude-lobster -- node /path/to/claude-lobster-mcp/dist/index.js

# Add for all your projects (user scope)
claude mcp add --transport stdio --scope user claude-lobster -- node /path/to/claude-lobster-mcp/dist/index.js
```

Verify it was added:

```bash
claude mcp get claude-lobster
```

Within a Claude Code session, check status with `/mcp`.

To remove:

```bash
claude mcp remove claude-lobster
```

### Write a Workflow

Create a `.lobster` file using standard Lobster YAML:

```yaml
name: my-workflow
args:
  task:
    required: true

steps:
  - id: orient
    pipeline: "llm.invoke --prompt 'Understand the task. Task: ${task}'"

  - id: consult
    pipeline: "llm.invoke --model opus --prompt 'Review and advise.'"
    stdin: $orient.json
    approval: Advisor must respond

  - id: execute
    pipeline: "llm.invoke --prompt 'Execute the plan.'"
    stdin: $consult.json
```

### Lead Agent Prompt

The lead agent's system prompt shrinks to:

```
You have a workflow tool (claude-lobster-mcp). At the start of every
session, call workflow_load with the workflow file path provided.

The workflow returns steps one at a time. Each step tells you exactly
what to do — which tool to call, with what args. Follow the instruction,
then call workflow_complete with your results to advance.

For approval gates, call workflow_approve after the gate condition is met.
Call workflow_current to re-read the current step if needed.

The workflow controls the sequence. Do not skip or reorder steps.
```

## MCP Tools

### `workflow_load`

Load and initialize a workflow.

**Input**: `{ path: string, args?: object }`
**Returns**: Detected mode, workflow overview, first step instruction.

### `workflow_current`

Get the current step's translated instruction.

**Returns**: Step id, action type, what tool to call, with what args, resolved context.

### `workflow_complete`

Mark current step done and advance.

**Input**: `{ step_id: string, output?: any }`
**Returns**: Next step instruction, or workflow completion status.

### `workflow_approve`

Satisfy an approval gate.

**Input**: `{ step_id: string, output?: any }`
**Returns**: Next step instruction after the gate.

### `workflow_status`

Get full workflow status.

**Returns**: All steps with states, current position, completion percentage.

## Workflow File Reference

Workflow files use standard Lobster YAML. Supported constructs:

| Field | Description |
|---|---|
| `pipeline:` | Lobster pipeline command (e.g., `llm.invoke`) |
| `run:` / `command:` | Shell command |
| `parallel:` | Concurrent branches (flat, one command each) |
| `approval:` | Gate — blocks until explicitly approved |
| `stdin:` | Data input — `$stepId.json` or `$stepId.stdout` |
| `env:` | Environment variables for the step |
| `when:` / `condition:` | Conditional execution |
| `on_error:` | Error handling — `stop`, `continue`, `skip_rest` |
| `retry:` | Retry config — `max`, `delay_ms` |

### Variable Syntax

- `${argName}` — workflow arg interpolation in command strings
- `$stepId.json` — parsed JSON output from a completed step
- `$stepId.stdout` — raw stdout from a completed step
- `$stepId.approved` — boolean from an approval step

## Portability

The `.lobster` workflow file is the portable artifact:

| Environment | Runtime |
|---|---|
| OpenClaw | Native Lobster — no driver needed |
| Claude Code + Teams + tmux | This driver → Teams mode |
| Claude Code (no Teams) | This driver → Agent fallback |

No custom step types. No format extensions. Every field is a real Lobster field.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
