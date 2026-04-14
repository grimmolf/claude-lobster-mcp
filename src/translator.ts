import type {
  ExecutionMode,
  ParsedStep,
  ParsedBranch,
  TranslatedInstruction,
  TranslatedBranch,
  ActionType,
  WorkflowStepResult,
} from "./types.js";
import { parsePipelineCommand, resolveStdin, resolveArgsTemplate } from "./parser.js";

const HIGH_CAPABILITY_MODELS = new Set([
  "opus",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4",
]);

export function translateStep(
  step: ParsedStep,
  mode: ExecutionMode,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
  teammates: Map<string, string>,
  advisorPaneId?: string,
): TranslatedInstruction {
  if (step.parallel) {
    return translateParallel(step, mode, args, results, teammates);
  }

  if (step.pipeline) {
    return translatePipeline(step, mode, args, results, teammates, advisorPaneId);
  }

  const shellCmd = step.run ?? step.command;
  if (shellCmd) {
    return translateShell(step, shellCmd, args, results);
  }

  if (step.approval !== undefined) {
    return translateApprovalOnly(step);
  }

  return {
    stepId: step.id,
    actionType: "instruction",
    description: `Step ${step.id}: no recognized execution type`,
    hasApproval: false,
  };
}

function translatePipeline(
  step: ParsedStep,
  mode: ExecutionMode,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
  teammates: Map<string, string>,
  advisorPaneId?: string,
): TranslatedInstruction {
  const pipelineStr = resolveArgsTemplate(step.pipeline!, args);
  const cmd = parsePipelineCommand(pipelineStr);
  const resolvedStdin = resolveStdin(step.stdin, args, results);
  const approvalMsg = extractApprovalMessage(step.approval);
  const hasApproval = step.approval !== undefined;

  if (cmd.name === "llm.invoke") {
    const model = typeof cmd.args.model === "string" ? cmd.args.model : undefined;
    const prompt = typeof cmd.args.prompt === "string" ? cmd.args.prompt : undefined;
    const isAdvisor = model !== undefined && isHighCapabilityModel(model);

    if (isAdvisor) {
      return translateAdvisorCall(step.id, mode, model, prompt, resolvedStdin, hasApproval, approvalMsg, teammates, advisorPaneId);
    }

    return {
      stepId: step.id,
      actionType: "instruction",
      description: prompt
        ? `Execute this instruction using your judgment: ${prompt}`
        : `Execute the llm.invoke pipeline step`,
      prompt,
      stdin: resolvedStdin,
      hasApproval,
      approvalMessage: approvalMsg,
    };
  }

  return {
    stepId: step.id,
    actionType: "instruction",
    description: `Execute pipeline command: ${cmd.name}`,
    prompt: pipelineStr,
    stdin: resolvedStdin,
    hasApproval,
    approvalMessage: approvalMsg,
  };
}

function translateAdvisorCall(
  stepId: string,
  mode: ExecutionMode,
  model: string,
  prompt: string | undefined,
  stdin: unknown,
  hasApproval: boolean,
  approvalMsg: string | undefined,
  teammates: Map<string, string>,
  advisorPaneId?: string,
): TranslatedInstruction {
  const teammateName = `advisor-${model}`;
  const existingTeammate = teammates.get(model);

  if (mode === "teams") {
    if (existingTeammate) {
      return {
        stepId,
        actionType: "message_teammate",
        description: `Consult the ${model} advisor (already spawned as "${existingTeammate}"). Send context and await response. If no reply arrives, call workflow_scrape_advisor to read the pane directly.`,
        toolToCall: "message",
        toolArgs: {
          teammate: existingTeammate,
          content: formatAdvisorMessage(prompt, stdin),
        },
        prompt,
        stdin,
        hasApproval,
        approvalMessage: approvalMsg,
        advisorPane: advisorPaneId,
      };
    }

    teammates.set(model, teammateName);
    return {
      stepId,
      actionType: "spawn_teammate",
      description: `Spawn an ${model} advisor teammate named "${teammateName}" using TeamCreate, then send context for consultation.`,
      toolToCall: "TeamCreate",
      toolArgs: {
        name: teammateName,
        model,
        prompt: prompt ?? "You are a strategic advisor. Provide concise, actionable guidance.",
      },
      prompt,
      stdin,
      hasApproval,
      approvalMessage: approvalMsg,
    };
  }

  return {
    stepId,
    actionType: "instruction",
    description: `Consult a higher-capability model (${model}). Use the Agent tool with --model ${model} to get strategic guidance.`,
    toolToCall: "Agent",
    toolArgs: {
      model,
      prompt: formatAdvisorMessage(prompt, stdin),
    },
    prompt,
    stdin,
    hasApproval,
    approvalMessage: approvalMsg,
  };
}

function translateParallel(
  step: ParsedStep,
  mode: ExecutionMode,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
  teammates: Map<string, string>,
): TranslatedInstruction {
  const branches: TranslatedBranch[] = step.parallel!.branches.map((branch) =>
    translateBranch(branch, mode, args, results),
  );

  const approvalMsg = extractApprovalMessage(step.approval);

  if (mode === "teams") {
    return {
      stepId: step.id,
      actionType: "parallel_spawn",
      description: `Spawn ${branches.length} parallel teammates using TeamCreate. Each runs in its own tmux pane.`,
      branches,
      hasApproval: step.approval !== undefined,
      approvalMessage: approvalMsg,
    };
  }

  return {
    stepId: step.id,
    actionType: "parallel_spawn",
    description: `Run ${branches.length} parallel tasks using the Agent tool. Each runs as a background agent.`,
    branches,
    hasApproval: step.approval !== undefined,
    approvalMessage: approvalMsg,
  };
}

function translateBranch(
  branch: ParsedBranch,
  mode: ExecutionMode,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
): TranslatedBranch {
  const resolvedStdin = resolveStdin(branch.stdin, args, results);

  if (branch.pipeline) {
    const pipelineStr = resolveArgsTemplate(branch.pipeline, args);
    const cmd = parsePipelineCommand(pipelineStr);
    const prompt = cmd.name === "llm.invoke" && typeof cmd.args.prompt === "string"
      ? cmd.args.prompt
      : undefined;

    const toolToCall = mode === "teams" ? "TeamCreate" : "Agent";

    return {
      id: branch.id,
      actionType: mode === "teams" ? "spawn_teammate" : "instruction",
      description: prompt
        ? `Branch "${branch.id}": ${prompt}`
        : `Branch "${branch.id}": execute pipeline ${cmd.name}`,
      toolToCall,
      toolArgs: { name: `worker-${branch.id}`, model: "sonnet", prompt },
      prompt,
      stdin: resolvedStdin,
    };
  }

  const shellCmd = branch.run ?? branch.command;
  if (shellCmd) {
    return {
      id: branch.id,
      actionType: "shell",
      description: `Branch "${branch.id}": run shell command`,
      prompt: resolveArgsTemplate(shellCmd, args),
      stdin: resolvedStdin,
    };
  }

  return {
    id: branch.id,
    actionType: "instruction",
    description: `Branch "${branch.id}": no execution type`,
    stdin: resolvedStdin,
  };
}

function translateShell(
  step: ParsedStep,
  shellCmd: string,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
): TranslatedInstruction {
  const resolved = resolveArgsTemplate(shellCmd, args);
  const resolvedStdin = resolveStdin(step.stdin, args, results);
  const approvalMsg = extractApprovalMessage(step.approval);

  return {
    stepId: step.id,
    actionType: "shell",
    description: `Run shell command: ${resolved}`,
    prompt: resolved,
    stdin: resolvedStdin,
    hasApproval: step.approval !== undefined,
    approvalMessage: approvalMsg,
  };
}

function translateApprovalOnly(step: ParsedStep): TranslatedInstruction {
  const approvalMsg = extractApprovalMessage(step.approval);
  return {
    stepId: step.id,
    actionType: "approval_gate",
    description: approvalMsg ?? "Approval required before proceeding",
    hasApproval: true,
    approvalMessage: approvalMsg,
  };
}

function extractApprovalMessage(approval: ParsedStep["approval"]): string | undefined {
  if (typeof approval === "string") return approval;
  if (approval && typeof approval === "object" && "prompt" in approval) return approval.prompt;
  return undefined;
}

function isHighCapabilityModel(model: string): boolean {
  const lower = model.toLowerCase();
  return HIGH_CAPABILITY_MODELS.has(lower) || lower.includes("opus");
}

function formatAdvisorMessage(prompt: string | undefined, stdin: unknown): string {
  const parts: string[] = [];
  if (stdin !== null && stdin !== undefined) {
    parts.push(`CONTEXT:\n${typeof stdin === "string" ? stdin : JSON.stringify(stdin, null, 2)}`);
  }
  if (prompt) {
    parts.push(`QUESTION:\n${prompt}`);
  }
  return parts.join("\n\n") || "Please provide strategic guidance.";
}
