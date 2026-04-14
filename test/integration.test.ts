import { describe, it, expect } from "vitest";
import { getToolDefinitions, handleToolCall } from "../src/server.js";
import { join } from "node:path";

const WORKFLOW_PATH = join(import.meta.dirname, "..", "workflows", "teams-advisor.lobster");

describe("MCP tool integration", () => {
  it("lists all 6 tools", () => {
    const tools = getToolDefinitions();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("workflow_list");
    expect(names).toContain("workflow_load");
    expect(names).toContain("workflow_current");
    expect(names).toContain("workflow_complete");
    expect(names).toContain("workflow_approve");
    expect(names).toContain("workflow_status");
  });

  it("returns error when no workflow loaded", async () => {
    const result = await handleToolCall("workflow_current", {});
    expect(result.content[0].text).toContain("No workflow loaded");
  });

  it("runs the full advisor workflow lifecycle", async () => {
    // Load
    const loadResult = await handleToolCall("workflow_load", {
      path: WORKFLOW_PATH,
      args: { task: "Fix the authentication bug in the login module" },
    });
    const loaded = JSON.parse(loadResult.content[0].text);
    expect(loaded.loaded).toBe(true);
    expect(loaded.workflow.name).toBe("teams-advisor-session");
    expect(loaded.workflow.stepCount).toBe(6);
    expect(loaded.firstStep.stepId).toBe("orient");
    expect(loaded.firstStep.actionType).toBe("instruction");
    expect(loaded.firstStep.prompt).toContain("Fix the authentication bug");

    // Current should return orient
    const currentResult = await handleToolCall("workflow_current", {});
    const current = JSON.parse(currentResult.content[0].text);
    expect(current.stepId).toBe("orient");

    // Complete orient
    const completeOrient = await handleToolCall("workflow_complete", {
      step_id: "orient",
      output: { findings: "single-task, auth module affected", mode: "single-task" },
    });
    const afterOrient = JSON.parse(completeOrient.content[0].text);
    expect(afterOrient.nextStep.stepId).toBe("consult_approach");
    expect(afterOrient.nextStep.actionType).toMatch(/spawn_teammate|instruction/);

    // Complete consult_approach (has approval gate)
    const completeConsult = await handleToolCall("workflow_complete", {
      step_id: "consult_approach",
      output: { advice: "Focus on the token refresh logic" },
    });
    const afterConsult = JSON.parse(completeConsult.content[0].text);
    expect(afterConsult.nextStep.requiresApproval).toBe(true);

    // Approve
    const approveResult = await handleToolCall("workflow_approve", {
      step_id: "consult_approach",
      output: { approved: true },
    });
    const afterApprove = JSON.parse(approveResult.content[0].text);
    expect(afterApprove.nextStep.stepId).toBe("plan_execution");

    // Complete plan_execution
    await handleToolCall("workflow_complete", {
      step_id: "plan_execution",
      output: { plan: "Fix token refresh, add test" },
    });

    // Complete execute (parallel step)
    const completeExecute = await handleToolCall("workflow_complete", {
      step_id: "execute",
      output: { implementation: "done", verification: "passed" },
    });
    const afterExecute = JSON.parse(completeExecute.content[0].text);
    expect(afterExecute.nextStep.stepId).toBe("consult_review");
    // Teams mode: message_teammate (advisor already spawned). Agent fallback: instruction.
    expect(afterExecute.nextStep.actionType).toMatch(/message_teammate|instruction/);

    // Complete consult_review (has approval gate)
    await handleToolCall("workflow_complete", {
      step_id: "consult_review",
      output: { review: "Looks good" },
    });

    // Approve consult_review
    const approveReview = await handleToolCall("workflow_approve", {
      step_id: "consult_review",
    });
    const afterReview = JSON.parse(approveReview.content[0].text);
    expect(afterReview.nextStep.stepId).toBe("synthesize");

    // Complete synthesize
    const completeSynth = await handleToolCall("workflow_complete", {
      step_id: "synthesize",
      output: "All done",
    });
    const final = JSON.parse(completeSynth.content[0].text);
    expect(final.workflowComplete).toBe(true);

    // Status should show 100%
    const statusResult = await handleToolCall("workflow_status", {});
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.percentComplete).toBe(100);
    expect(status.completedCount).toBe(6);
  });

  it("handles wrong step_id gracefully", async () => {
    await handleToolCall("workflow_load", {
      path: WORKFLOW_PATH,
      args: { task: "Test error handling" },
    });
    const result = await handleToolCall("workflow_complete", {
      step_id: "nonexistent",
    });
    expect(result.content[0].text).toContain("Error");
  });
});
