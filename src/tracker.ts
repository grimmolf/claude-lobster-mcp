import type {
  WorkflowState,
  WorkflowStepResult,
  StepEntry,
  StepState,
  ParsedWorkflow,
  ExecutionMode,
  TranslatedInstruction,
} from "./types.js";
import { translateStep } from "./translator.js";

export function createWorkflowState(
  workflow: ParsedWorkflow,
  mode: ExecutionMode,
  args: Record<string, unknown>,
): WorkflowState {
  const resolvedArgs = resolveWorkflowArgs(workflow.args, args);

  const steps: StepEntry[] = workflow.steps.map((step) => ({
    id: step.id,
    state: "pending" as StepState,
  }));

  if (steps.length > 0) {
    steps[0].state = "active";
  }

  return {
    name: workflow.name,
    description: workflow.description,
    mode,
    currentIndex: 0,
    steps,
    results: {},
    args: resolvedArgs,
    teammates: new Map(),
  };
}

export function getCurrentStep(
  state: WorkflowState,
  workflow: ParsedWorkflow,
): TranslatedInstruction | null {
  if (state.currentIndex >= workflow.steps.length) return null;

  const step = workflow.steps[state.currentIndex];
  const entry = state.steps[state.currentIndex];

  if (entry.state === "completed" || entry.state === "skipped") return null;

  return translateStep(step, state.mode, state.args, state.results, state.teammates, state.advisorPaneId);
}

export function completeStep(
  state: WorkflowState,
  workflow: ParsedWorkflow,
  stepId: string,
  output: unknown,
): { nextInstruction: TranslatedInstruction | null; workflowComplete: boolean } {
  const entry = state.steps[state.currentIndex];
  if (!entry || entry.id !== stepId) {
    throw new Error(`Cannot complete step "${stepId}" — current step is "${entry?.id}"`);
  }
  if (entry.state === "completed") {
    throw new Error(`Step "${stepId}" is already completed`);
  }

  const currentStep = workflow.steps[state.currentIndex];
  const hasApproval = currentStep.approval !== undefined;

  if (hasApproval && entry.state !== "waiting_approval") {
    entry.state = "waiting_approval";
    const result = buildStepResult(stepId, output);
    state.results[stepId] = result;
    entry.result = result;

    return {
      nextInstruction: {
        stepId,
        actionType: "approval_gate",
        description: typeof currentStep.approval === "string"
          ? currentStep.approval
          : "Approval required before advancing",
        hasApproval: true,
        approvalMessage: typeof currentStep.approval === "string"
          ? currentStep.approval
          : undefined,
      },
      workflowComplete: false,
    };
  }

  entry.state = "completed";
  const result = buildStepResult(stepId, output);
  state.results[stepId] = result;
  entry.result = result;

  return advanceToNext(state, workflow);
}

export function approveStep(
  state: WorkflowState,
  workflow: ParsedWorkflow,
  stepId: string,
  output?: unknown,
): { nextInstruction: TranslatedInstruction | null; workflowComplete: boolean } {
  const entry = state.steps[state.currentIndex];
  if (!entry || entry.id !== stepId) {
    throw new Error(`Cannot approve step "${stepId}" — current step is "${entry?.id}"`);
  }
  if (entry.state !== "waiting_approval") {
    throw new Error(`Step "${stepId}" is not waiting for approval (state: ${entry.state})`);
  }

  entry.state = "completed";
  if (output !== undefined) {
    const result = state.results[stepId];
    if (result) {
      result.approved = true;
      if (typeof output === "object" && output !== null) {
        result.json = output;
      }
    }
  } else {
    const result = state.results[stepId];
    if (result) result.approved = true;
  }

  return advanceToNext(state, workflow);
}

export function getStatus(
  state: WorkflowState,
): {
  name: string;
  mode: ExecutionMode;
  steps: Array<{ id: string; state: StepState }>;
  currentStepId: string | null;
  completedCount: number;
  totalCount: number;
  percentComplete: number;
} {
  const completedCount = state.steps.filter(
    (s) => s.state === "completed" || s.state === "skipped",
  ).length;

  return {
    name: state.name,
    mode: state.mode,
    steps: state.steps.map((s) => ({ id: s.id, state: s.state })),
    currentStepId: state.currentIndex < state.steps.length
      ? state.steps[state.currentIndex].id
      : null,
    completedCount,
    totalCount: state.steps.length,
    percentComplete: Math.round((completedCount / state.steps.length) * 100),
  };
}

function advanceToNext(
  state: WorkflowState,
  workflow: ParsedWorkflow,
): { nextInstruction: TranslatedInstruction | null; workflowComplete: boolean } {
  state.currentIndex++;

  while (state.currentIndex < workflow.steps.length) {
    const nextStep = workflow.steps[state.currentIndex];
    const nextEntry = state.steps[state.currentIndex];

    if (shouldSkip(nextStep, state)) {
      nextEntry.state = "skipped";
      state.results[nextStep.id] = { id: nextStep.id, skipped: true };
      state.currentIndex++;
      continue;
    }

    nextEntry.state = "active";
    const instruction = translateStep(
      nextStep,
      state.mode,
      state.args,
      state.results,
      state.teammates,
      state.advisorPaneId,
    );
    return { nextInstruction: instruction, workflowComplete: false };
  }

  return { nextInstruction: null, workflowComplete: true };
}

function shouldSkip(
  step: ParsedWorkflow["steps"][number],
  state: WorkflowState,
): boolean {
  if (step.when === undefined && step.condition === undefined) return false;

  const expr = step.when ?? step.condition;
  if (typeof expr === "boolean") return !expr;

  if (typeof expr === "string") {
    return !evaluateSimpleCondition(expr, state.results);
  }

  return false;
}

/**
 * Minimal condition evaluator for `$stepId.property == "value"` patterns.
 * Covers the most common Lobster when/condition usage.
 */
function evaluateSimpleCondition(
  expr: string,
  results: Record<string, WorkflowStepResult>,
): boolean {
  const eqMatch = expr.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_.]+)\s*==\s*"([^"]*)"$/);
  if (eqMatch) {
    const [, stepId, path, expected] = eqMatch;
    const stepResult = results[stepId];
    if (!stepResult) return false;
    const value = getNestedValue(stepResult, path);
    return String(value) === expected;
  }

  const boolMatch = expr.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_.]+)$/);
  if (boolMatch) {
    const [, stepId, path] = boolMatch;
    const stepResult = results[stepId];
    if (!stepResult) return false;
    return Boolean(getNestedValue(stepResult, path));
  }

  return true;
}

function getNestedValue(obj: object, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as { [k: string]: unknown })[part];
  }
  return current;
}

function buildStepResult(stepId: string, output: unknown): WorkflowStepResult {
  if (output && typeof output === "object" && "error" in output) {
    const errOutput = output as { error: boolean; errorMessage?: string };
    return {
      id: stepId,
      error: true,
      errorMessage: errOutput.errorMessage ?? "Step failed",
      json: output,
      stdout: JSON.stringify(output),
    };
  }

  const json = typeof output === "string" ? tryParseJson(output) : output;
  return {
    id: stepId,
    json: json ?? output,
    stdout: typeof output === "string" ? output : JSON.stringify(output),
  };
}

function tryParseJson(str: string): unknown | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function resolveWorkflowArgs(
  argDefs: ParsedWorkflow["args"],
  provided: Record<string, unknown>,
): Record<string, unknown> {
  if (!argDefs) return { ...provided };

  const resolved: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(argDefs)) {
    if (key in provided) {
      resolved[key] = provided[key];
    } else if (def && typeof def === "object" && "default" in def) {
      resolved[key] = def.default;
    } else if (def && typeof def === "object" && "required" in def && def.required) {
      throw new Error(`Required workflow arg "${key}" not provided`);
    }
  }

  for (const [key, value] of Object.entries(provided)) {
    if (!(key in resolved)) {
      resolved[key] = value;
    }
  }

  return resolved;
}
