import { readdir, stat } from "node:fs/promises";
import { join, isAbsolute, extname, basename } from "node:path";
import { homedir } from "node:os";
import type { ParsedWorkflow, WorkflowState, TranslatedInstruction } from "./types.js";
import { loadWorkflow } from "./parser.js";
import { detectExecutionMode, downgradeToAgent } from "./detector.js";
import { createWorkflowState, getCurrentStep, completeStep, approveStep, getStatus } from "./tracker.js";

const WORKFLOW_DIR = join(homedir(), ".config", "pai", "workflows");

let workflow: ParsedWorkflow | null = null;
let state: WorkflowState | null = null;

export function getToolDefinitions() {
  return [
    {
      name: "workflow_list",
      description:
        "List available workflow files from ~/.config/pai/workflows/. " +
        "Returns names and descriptions of all .lobster and .yaml workflow files.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "workflow_load",
      description:
        "Load a Lobster workflow file and initialize the workflow engine. " +
        "Accepts a workflow name (resolved from ~/.config/pai/workflows/) " +
        "or an absolute path. Returns the detected execution mode, " +
        "workflow overview, and the first step instruction.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description:
              "Workflow name (e.g., 'teams-advisor') resolved from ~/.config/pai/workflows/, " +
              "or an absolute path to a .lobster file",
          },
          args: {
            type: "object",
            description: "Workflow arguments (key-value pairs)",
            additionalProperties: true,
          },
        },
        required: ["name"],
      },
    },
    {
      name: "workflow_current",
      description:
        "Get the current workflow step with a translated instruction. " +
        "Returns exactly what you need to do: which tool to call, with what args. " +
        "Always returns the same step until workflow_complete is called.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "workflow_complete",
      description:
        "Mark the current step as done and advance to the next step. " +
        "If the step has an approval gate, this transitions to waiting_approval " +
        "instead of advancing — call workflow_approve to proceed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          step_id: {
            type: "string",
            description: "The id of the step being completed (must match current step)",
          },
          output: {
            description: "The result/output from executing the step",
          },
        },
        required: ["step_id"],
      },
    },
    {
      name: "workflow_approve",
      description:
        "Satisfy an approval gate on the current step and advance. " +
        "Only valid when the current step is in waiting_approval state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          step_id: {
            type: "string",
            description: "The id of the step being approved",
          },
          output: {
            description: "Optional additional output (e.g., advisor's response)",
          },
        },
        required: ["step_id"],
      },
    },
    {
      name: "workflow_status",
      description:
        "Get the overall workflow status: all steps with their states, " +
        "current position, and completion percentage.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    switch (name) {
      case "workflow_list":
        return await handleList();
      case "workflow_load":
        return await handleLoad(args);
      case "workflow_current":
        return handleCurrent();
      case "workflow_complete":
        return handleComplete(args);
      case "workflow_approve":
        return handleApprove(args);
      case "workflow_status":
        return handleStatus();
      default:
        return textResponse(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResponse(`Error: ${message}`);
  }
}

async function handleList() {
  const workflows: Array<{ name: string; path: string; description?: string }> = [];

  try {
    const entries = await readdir(WORKFLOW_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".lobster") && !entry.endsWith(".yaml") && !entry.endsWith(".yml")) {
        continue;
      }
      const fullPath = join(WORKFLOW_DIR, entry);
      const info = await stat(fullPath);
      if (!info.isFile()) continue;

      try {
        const wf = await loadWorkflow(fullPath);
        workflows.push({
          name: basename(entry, extname(entry)),
          path: fullPath,
          description: wf.description,
        });
      } catch {
        workflows.push({
          name: basename(entry, extname(entry)),
          path: fullPath,
          description: "(failed to parse)",
        });
      }
    }
  } catch {
    return textResponse(JSON.stringify({
      workflowDir: WORKFLOW_DIR,
      workflows: [],
      message: `No workflows found. Place .lobster files in ${WORKFLOW_DIR}`,
    }, null, 2));
  }

  return textResponse(JSON.stringify({
    workflowDir: WORKFLOW_DIR,
    workflows,
  }, null, 2));
}

async function handleLoad(args: Record<string, unknown>) {
  const nameOrPath = (args.name ?? args.path) as string;
  if (!nameOrPath) {
    throw new Error("name is required — provide a workflow name or absolute path");
  }

  const filePath = await resolveWorkflowPath(nameOrPath);
  workflow = await loadWorkflow(filePath);
  const detection = detectExecutionMode();
  const workflowArgs = (args.args as Record<string, unknown>) ?? {};

  state = createWorkflowState(workflow, detection.mode, workflowArgs);

  const firstStep = getCurrentStep(state, workflow);

  return textResponse(JSON.stringify({
    loaded: true,
    workflow: {
      name: workflow.name,
      description: workflow.description,
      stepCount: workflow.steps.length,
    },
    detection: {
      mode: detection.mode,
      reason: detection.reason,
    },
    firstStep: firstStep ? formatInstruction(firstStep) : null,
  }, null, 2));
}

function handleCurrent() {
  assertLoaded();
  const instruction = getCurrentStep(state!, workflow!);

  if (!instruction) {
    return textResponse(JSON.stringify({
      workflowComplete: true,
      message: "All steps have been completed.",
    }, null, 2));
  }

  return textResponse(JSON.stringify(formatInstruction(instruction), null, 2));
}

function handleComplete(args: Record<string, unknown>) {
  assertLoaded();
  const stepId = args.step_id as string;
  if (!stepId) throw new Error("step_id is required");

  const result = completeStep(state!, workflow!, stepId, args.output);

  if (result.workflowComplete) {
    return textResponse(JSON.stringify({
      completed: true,
      stepId,
      workflowComplete: true,
      message: "Workflow is complete. All steps finished.",
      status: getStatus(state!),
    }, null, 2));
  }

  return textResponse(JSON.stringify({
    completed: true,
    stepId,
    workflowComplete: false,
    nextStep: result.nextInstruction ? formatInstruction(result.nextInstruction) : null,
  }, null, 2));
}

function handleApprove(args: Record<string, unknown>) {
  assertLoaded();
  const stepId = args.step_id as string;
  if (!stepId) throw new Error("step_id is required");

  const result = approveStep(state!, workflow!, stepId, args.output);

  if (result.workflowComplete) {
    return textResponse(JSON.stringify({
      approved: true,
      stepId,
      workflowComplete: true,
      message: "Workflow is complete. All steps finished.",
      status: getStatus(state!),
    }, null, 2));
  }

  return textResponse(JSON.stringify({
    approved: true,
    stepId,
    workflowComplete: false,
    nextStep: result.nextInstruction ? formatInstruction(result.nextInstruction) : null,
  }, null, 2));
}

function handleStatus() {
  assertLoaded();
  return textResponse(JSON.stringify(getStatus(state!), null, 2));
}

function assertLoaded() {
  if (!workflow || !state) {
    throw new Error("No workflow loaded. Call workflow_load first.");
  }
}

function formatInstruction(instr: TranslatedInstruction): Record<string, unknown> {
  const result: Record<string, unknown> = {
    stepId: instr.stepId,
    actionType: instr.actionType,
    description: instr.description,
  };

  if (instr.toolToCall) result.toolToCall = instr.toolToCall;
  if (instr.toolArgs) result.toolArgs = instr.toolArgs;
  if (instr.prompt) result.prompt = instr.prompt;
  if (instr.stdin !== null && instr.stdin !== undefined) result.context = instr.stdin;
  if (instr.hasApproval) {
    result.requiresApproval = true;
    if (instr.approvalMessage) result.approvalMessage = instr.approvalMessage;
  }
  if (instr.branches) {
    result.branches = instr.branches.map((b) => ({
      id: b.id,
      actionType: b.actionType,
      description: b.description,
      toolToCall: b.toolToCall,
      toolArgs: b.toolArgs,
      prompt: b.prompt,
      context: b.stdin,
    }));
  }

  return result;
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function downgradeMode() {
  if (!state) return;
  const detection = detectExecutionMode();
  const downgraded = downgradeToAgent(detection);
  state.mode = downgraded.mode;
}

async function resolveWorkflowPath(nameOrPath: string): Promise<string> {
  if (isAbsolute(nameOrPath)) return nameOrPath;

  const candidates = [
    join(WORKFLOW_DIR, nameOrPath),
    join(WORKFLOW_DIR, `${nameOrPath}.lobster`),
    join(WORKFLOW_DIR, `${nameOrPath}.yaml`),
    join(WORKFLOW_DIR, `${nameOrPath}.yml`),
  ];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Workflow "${nameOrPath}" not found. Searched:\n` +
    candidates.map((c) => `  - ${c}`).join("\n") +
    `\n\nUse workflow_list to see available workflows.`,
  );
}
