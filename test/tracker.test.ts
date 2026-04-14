import { describe, it, expect } from "vitest";
import { createWorkflowState, getCurrentStep, completeStep, approveStep, getStatus } from "../src/tracker.js";
import type { ParsedWorkflow } from "../src/types.js";

const simpleWorkflow: ParsedWorkflow = {
  name: "test",
  steps: [
    { id: "step1", pipeline: "llm.invoke --prompt 'Do A'" },
    { id: "step2", pipeline: "llm.invoke --prompt 'Do B'", stdin: "$step1.json" },
    { id: "step3", pipeline: "llm.invoke --prompt 'Do C'" },
  ],
};

const advisorWorkflow: ParsedWorkflow = {
  name: "advisor-test",
  steps: [
    { id: "orient", pipeline: "llm.invoke --prompt 'Orient'" },
    {
      id: "consult",
      pipeline: "llm.invoke --model opus --prompt 'Advise'",
      stdin: "$orient.json",
      approval: "Advisor must respond",
    },
    { id: "execute", pipeline: "llm.invoke --prompt 'Execute'" },
  ],
};

describe("createWorkflowState", () => {
  it("initializes with first step active", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    expect(state.steps[0].state).toBe("active");
    expect(state.steps[1].state).toBe("pending");
    expect(state.currentIndex).toBe(0);
  });

  it("resolves required args", () => {
    const wf: ParsedWorkflow = {
      name: "t",
      args: { task: { required: true } },
      steps: [{ id: "s", run: "echo" }],
    };
    expect(() => createWorkflowState(wf, "teams", {})).toThrow('Required workflow arg "task"');
  });

  it("applies default args", () => {
    const wf: ParsedWorkflow = {
      name: "t",
      args: { mode: { default: "auto" } },
      steps: [{ id: "s", run: "echo" }],
    };
    const state = createWorkflowState(wf, "teams", {});
    expect(state.args.mode).toBe("auto");
  });
});

describe("getCurrentStep", () => {
  it("returns translated instruction for current step", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    const instr = getCurrentStep(state, simpleWorkflow);
    expect(instr?.stepId).toBe("step1");
    expect(instr?.actionType).toBe("instruction");
  });

  it("returns null when all steps done", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    completeStep(state, simpleWorkflow, "step1", "a");
    completeStep(state, simpleWorkflow, "step2", "b");
    completeStep(state, simpleWorkflow, "step3", "c");
    expect(getCurrentStep(state, simpleWorkflow)).toBeNull();
  });
});

describe("completeStep", () => {
  it("advances to next step", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    const result = completeStep(state, simpleWorkflow, "step1", "done");
    expect(result.nextInstruction?.stepId).toBe("step2");
    expect(result.workflowComplete).toBe(false);
  });

  it("transitions to waiting_approval for steps with approval gates", () => {
    const state = createWorkflowState(advisorWorkflow, "teams", {});
    completeStep(state, advisorWorkflow, "orient", "findings");
    const result = completeStep(state, advisorWorkflow, "consult", "advice");
    expect(result.nextInstruction?.actionType).toBe("approval_gate");
    expect(state.steps[1].state).toBe("waiting_approval");
  });

  it("reports workflow complete on last step", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    completeStep(state, simpleWorkflow, "step1", "a");
    completeStep(state, simpleWorkflow, "step2", "b");
    const result = completeStep(state, simpleWorkflow, "step3", "c");
    expect(result.workflowComplete).toBe(true);
  });

  it("throws on wrong step id", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    expect(() => completeStep(state, simpleWorkflow, "wrong", "x")).toThrow("current step");
  });

  it("stores result in results map", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    completeStep(state, simpleWorkflow, "step1", { data: "value" });
    expect(state.results.step1.json).toEqual({ data: "value" });
  });
});

describe("approveStep", () => {
  it("advances past approval gate", () => {
    const state = createWorkflowState(advisorWorkflow, "teams", {});
    completeStep(state, advisorWorkflow, "orient", "findings");
    completeStep(state, advisorWorkflow, "consult", "advice");
    const result = approveStep(state, advisorWorkflow, "consult");
    expect(result.nextInstruction?.stepId).toBe("execute");
    expect(state.steps[1].state).toBe("completed");
  });

  it("throws if step is not waiting for approval", () => {
    const state = createWorkflowState(advisorWorkflow, "teams", {});
    expect(() => approveStep(state, advisorWorkflow, "orient")).toThrow("not waiting for approval");
  });
});

describe("getStatus", () => {
  it("reports completion percentage", () => {
    const state = createWorkflowState(simpleWorkflow, "teams", {});
    completeStep(state, simpleWorkflow, "step1", "a");
    const status = getStatus(state);
    expect(status.completedCount).toBe(1);
    expect(status.totalCount).toBe(3);
    expect(status.percentComplete).toBe(33);
  });
});

describe("conditional steps (when)", () => {
  it("skips steps where when condition is false", () => {
    const wf: ParsedWorkflow = {
      name: "conditional",
      steps: [
        { id: "check", run: "echo ok" },
        { id: "skip_me", run: "echo skip", when: false },
        { id: "after", run: "echo after" },
      ],
    };
    const state = createWorkflowState(wf, "teams", {});
    const result = completeStep(state, wf, "check", "ok");
    expect(result.nextInstruction?.stepId).toBe("after");
    expect(state.steps[1].state).toBe("skipped");
  });
});
