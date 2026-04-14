import { describe, it, expect } from "vitest";
import { translateStep } from "../src/translator.js";
import type { ParsedStep, WorkflowStepResult } from "../src/types.js";

describe("translateStep", () => {
  const emptyArgs: Record<string, unknown> = {};
  const emptyResults: Record<string, WorkflowStepResult> = {};

  describe("pipeline steps", () => {
    it("translates standard llm.invoke as instruction", () => {
      const step: ParsedStep = {
        id: "orient",
        pipeline: "llm.invoke --prompt 'Do the thing'",
      };
      const result = translateStep(step, "teams", emptyArgs, emptyResults, new Map());
      expect(result.actionType).toBe("instruction");
      expect(result.prompt).toContain("Do the thing");
    });

    it("translates llm.invoke --model opus as spawn_teammate in teams mode", () => {
      const step: ParsedStep = {
        id: "consult",
        pipeline: "llm.invoke --model opus --prompt 'Review approach'",
        approval: "Wait for advisor",
      };
      const teammates = new Map<string, string>();
      const result = translateStep(step, "teams", emptyArgs, emptyResults, teammates);
      expect(result.actionType).toBe("spawn_teammate");
      expect(result.toolToCall).toBe("TeamCreate");
      expect(teammates.has("opus")).toBe(true);
    });

    it("translates second opus call as message_teammate", () => {
      const step: ParsedStep = {
        id: "review",
        pipeline: "llm.invoke --model opus --prompt 'Final review'",
      };
      const teammates = new Map([["opus", "advisor-opus"]]);
      const result = translateStep(step, "teams", emptyArgs, emptyResults, teammates);
      expect(result.actionType).toBe("message_teammate");
      expect(result.toolToCall).toBe("message");
    });

    it("translates opus call as instruction with Agent in fallback mode", () => {
      const step: ParsedStep = {
        id: "consult",
        pipeline: "llm.invoke --model opus --prompt 'Review'",
      };
      const result = translateStep(step, "agent", emptyArgs, emptyResults, new Map());
      expect(result.actionType).toBe("instruction");
      expect(result.toolToCall).toBe("Agent");
    });
  });

  describe("parallel steps", () => {
    it("translates parallel as parallel_spawn", () => {
      const step: ParsedStep = {
        id: "exec",
        parallel: {
          branches: [
            { id: "a", pipeline: "llm.invoke --prompt 'Work A'" },
            { id: "b", pipeline: "llm.invoke --prompt 'Work B'" },
          ],
        },
      };
      const result = translateStep(step, "teams", emptyArgs, emptyResults, new Map());
      expect(result.actionType).toBe("parallel_spawn");
      expect(result.branches).toHaveLength(2);
      expect(result.branches![0].toolToCall).toBe("TeamCreate");
    });

    it("uses Agent tool in fallback mode", () => {
      const step: ParsedStep = {
        id: "exec",
        parallel: {
          branches: [
            { id: "a", pipeline: "llm.invoke --prompt 'Work'" },
          ],
        },
      };
      const result = translateStep(step, "agent", emptyArgs, emptyResults, new Map());
      expect(result.branches![0].toolToCall).toBe("Agent");
    });
  });

  describe("shell steps", () => {
    it("translates run as shell action", () => {
      const step: ParsedStep = { id: "test", run: "npm test" };
      const result = translateStep(step, "teams", emptyArgs, emptyResults, new Map());
      expect(result.actionType).toBe("shell");
      expect(result.prompt).toBe("npm test");
    });
  });

  describe("approval-only steps", () => {
    it("translates standalone approval as approval_gate", () => {
      const step: ParsedStep = { id: "gate", approval: "Please confirm" };
      const result = translateStep(step, "teams", emptyArgs, emptyResults, new Map());
      expect(result.actionType).toBe("approval_gate");
      expect(result.hasApproval).toBe(true);
      expect(result.approvalMessage).toBe("Please confirm");
    });
  });

  describe("stdin resolution", () => {
    it("resolves step refs in stdin", () => {
      const step: ParsedStep = {
        id: "next",
        pipeline: "llm.invoke --prompt 'Continue'",
        stdin: "$orient.json",
      };
      const results: Record<string, WorkflowStepResult> = {
        orient: { id: "orient", json: { findings: "auth bug" } },
      };
      const result = translateStep(step, "teams", emptyArgs, results, new Map());
      expect(result.stdin).toEqual({ findings: "auth bug" });
    });
  });
});
