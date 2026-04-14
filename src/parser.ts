import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ParsedWorkflow, ParsedStep, ParsedBranch, ParsedPipelineCommand } from "./types.js";

export async function loadWorkflow(filePath: string): Promise<ParsedWorkflow> {
  const raw = await readFile(filePath, "utf-8");
  const doc = parseYaml(raw);

  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid workflow file: expected YAML object at ${filePath}`);
  }

  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error(`Workflow requires a non-empty steps array`);
  }

  const seen = new Set<string>();
  const steps: ParsedStep[] = [];

  for (const rawStep of doc.steps) {
    const step = validateStep(rawStep, seen);
    steps.push(step);
  }

  return {
    name: typeof doc.name === "string" ? doc.name : "unnamed-workflow",
    description: typeof doc.description === "string" ? doc.description : undefined,
    args: doc.args ?? undefined,
    steps,
  };
}

function validateStep(raw: unknown, seen: Set<string>): ParsedStep {
  if (!raw || typeof raw !== "object") {
    throw new Error("Each workflow step must be an object");
  }

  const step = raw as Record<string, unknown>;

  if (typeof step.id !== "string" || !step.id.trim()) {
    throw new Error("Each workflow step requires a string id");
  }
  if (seen.has(step.id)) {
    throw new Error(`Duplicate step id: ${step.id}`);
  }
  seen.add(step.id);

  const hasRun = typeof step.run === "string";
  const hasCommand = typeof step.command === "string";
  const hasPipeline = typeof step.pipeline === "string";
  const hasParallel = step.parallel && typeof step.parallel === "object" && !Array.isArray(step.parallel);
  const hasApprovalOnly = step.approval !== undefined && !hasRun && !hasCommand && !hasPipeline && !hasParallel;

  const executionCount = [hasRun, hasCommand, hasPipeline, hasParallel].filter(Boolean).length;

  if (executionCount === 0 && !hasApprovalOnly) {
    throw new Error(`Step ${step.id} requires run, command, pipeline, parallel, or approval`);
  }
  if (executionCount > 1) {
    throw new Error(`Step ${step.id} can only define one of run, command, pipeline, or parallel`);
  }

  const parsed: ParsedStep = { id: step.id };

  if (hasPipeline) parsed.pipeline = step.pipeline as string;
  if (hasRun) parsed.run = step.run as string;
  if (hasCommand) parsed.command = step.command as string;
  if (step.approval !== undefined) {
    parsed.approval = typeof step.approval === "string"
      ? step.approval
      : step.approval as { prompt: string };
  }
  if (step.stdin !== undefined) parsed.stdin = step.stdin;
  if (step.env && typeof step.env === "object") parsed.env = step.env as Record<string, string>;
  if (step.when !== undefined) parsed.when = step.when;
  if (step.condition !== undefined) parsed.condition = step.condition;
  if (step.on_error !== undefined) parsed.on_error = step.on_error as ParsedStep["on_error"];
  if (step.retry !== undefined) parsed.retry = step.retry as ParsedStep["retry"];
  if (step.timeout_ms !== undefined) parsed.timeout_ms = step.timeout_ms as number;

  if (hasParallel) {
    const pc = step.parallel as Record<string, unknown>;
    if (!Array.isArray(pc.branches) || pc.branches.length === 0) {
      throw new Error(`Step ${step.id} parallel requires a non-empty branches array`);
    }

    const branchIds = new Set<string>();
    const branches: ParsedBranch[] = [];

    for (const rawBranch of pc.branches) {
      if (!rawBranch || typeof rawBranch !== "object") {
        throw new Error(`Step ${step.id} parallel branches must be objects`);
      }
      const branch = rawBranch as Record<string, unknown>;
      if (typeof branch.id !== "string" || !branch.id.trim()) {
        throw new Error(`Step ${step.id} parallel branch requires an id`);
      }
      if (branchIds.has(branch.id)) {
        throw new Error(`Step ${step.id} duplicate parallel branch id: ${branch.id}`);
      }
      if (seen.has(branch.id)) {
        throw new Error(`Duplicate id across steps/branches: ${branch.id}`);
      }
      branchIds.add(branch.id);
      seen.add(branch.id);

      const bRun = typeof branch.run === "string" ? branch.run : undefined;
      const bCmd = typeof branch.command === "string" ? branch.command : undefined;
      const bPipe = typeof branch.pipeline === "string" ? branch.pipeline : undefined;
      const bExecCount = [bRun, bCmd, bPipe].filter(Boolean).length;

      if (bExecCount === 0) {
        throw new Error(`Step ${step.id} branch ${branch.id} requires run, command, or pipeline`);
      }
      if (bExecCount > 1) {
        throw new Error(`Step ${step.id} branch ${branch.id} can only define one of run, command, or pipeline`);
      }

      branches.push({
        id: branch.id,
        run: bRun,
        command: bCmd,
        pipeline: bPipe,
        env: branch.env as Record<string, string> | undefined,
        stdin: branch.stdin,
      });
    }

    parsed.parallel = {
      wait: pc.wait === "any" ? "any" : "all",
      timeout_ms: typeof pc.timeout_ms === "number" ? pc.timeout_ms : undefined,
      branches,
    };
  }

  return parsed;
}

/**
 * Parse a Lobster pipeline string like `llm.invoke --model opus --prompt "text"`
 * into a structured command with name and args.
 */
export function parsePipelineCommand(pipelineStr: string): ParsedPipelineCommand {
  const tokens = tokenize(pipelineStr.trim());
  if (tokens.length === 0) throw new Error("Empty pipeline string");

  const name = tokens[0];
  const args: Record<string, string | boolean> = {};

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      if (!args._positional) args._positional = token;
      i += 1;
    }
  }

  return { name, args };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Resolve `${argName}` template references in a string.
 */
export function resolveArgsTemplate(
  input: string,
  args: Record<string, unknown>,
): string {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

/**
 * Resolve `$stepId.property` references (e.g., `$orient.json`).
 * Returns the resolved value for stdin-style references.
 */
export function resolveStepRef(
  ref: string,
  results: Record<string, { id: string; stdout?: string; json?: unknown; approved?: boolean }>,
): unknown {
  const match = ref.trim().match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_.]+)$/);
  if (!match) return ref;

  const [, stepId, path] = match;
  const stepResult = results[stepId];
  if (!stepResult) throw new Error(`Unknown step reference: ${stepId}.${path}`);

  return getValueByPath(stepResult, path);
}

/**
 * Resolve a stdin value — could be a step ref like `$orient.json`,
 * an args template like `${task}`, or a literal value.
 */
export function resolveStdin(
  stdin: unknown,
  args: Record<string, unknown>,
  results: Record<string, { id: string; stdout?: string; json?: unknown; approved?: boolean }>,
): unknown {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin !== "string") return stdin;

  const trimmed = stdin.trim();
  const refMatch = trimmed.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_.]+)$/);
  if (refMatch) {
    return resolveStepRef(trimmed, results);
  }

  return resolveArgsTemplate(trimmed, args);
}

function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
