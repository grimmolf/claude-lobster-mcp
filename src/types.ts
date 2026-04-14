export type ExecutionMode = "teams" | "agent";

export interface DetectionResult {
  mode: ExecutionMode;
  teamsEnvVar: boolean;
  insideTmux: boolean;
  reason: string;
}

export interface WorkflowStepResult {
  id: string;
  stdout?: string;
  json?: unknown;
  approved?: boolean;
  skipped?: boolean;
  error?: boolean;
  errorMessage?: string;
}

export type StepState =
  | "pending"
  | "active"
  | "waiting_approval"
  | "completed"
  | "skipped";

export type ActionType =
  | "spawn_teammate"
  | "message_teammate"
  | "parallel_spawn"
  | "instruction"
  | "shell"
  | "approval_gate";

export interface TranslatedInstruction {
  stepId: string;
  actionType: ActionType;
  description: string;
  toolToCall?: string;
  toolArgs?: Record<string, unknown>;
  prompt?: string;
  stdin?: unknown;
  hasApproval: boolean;
  approvalMessage?: string;
  branches?: TranslatedBranch[];
}

export interface TranslatedBranch {
  id: string;
  actionType: ActionType;
  description: string;
  toolToCall?: string;
  toolArgs?: Record<string, unknown>;
  prompt?: string;
  stdin?: unknown;
}

export interface StepEntry {
  id: string;
  state: StepState;
  result?: WorkflowStepResult;
}

export interface WorkflowState {
  name: string;
  description?: string;
  mode: ExecutionMode;
  currentIndex: number;
  steps: StepEntry[];
  results: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  teammates: Map<string, string>;
}

export interface ParsedPipelineCommand {
  name: string;
  args: Record<string, string | boolean>;
}

export interface ParsedWorkflow {
  name: string;
  description?: string;
  args?: Record<string, { required?: boolean; default?: unknown; description?: string }>;
  steps: ParsedStep[];
}

export interface ParsedStep {
  id: string;
  pipeline?: string;
  run?: string;
  command?: string;
  approval?: string | { prompt: string };
  stdin?: unknown;
  env?: Record<string, string>;
  when?: unknown;
  condition?: unknown;
  parallel?: {
    wait?: "all" | "any";
    timeout_ms?: number;
    branches: ParsedBranch[];
  };
  on_error?: "stop" | "continue" | "skip_rest";
  retry?: { max?: number; delay_ms?: number };
  timeout_ms?: number;
}

export interface ParsedBranch {
  id: string;
  run?: string;
  command?: string;
  pipeline?: string;
  env?: Record<string, string>;
  stdin?: unknown;
}
